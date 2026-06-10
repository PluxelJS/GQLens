# GraphDataStore 持久化设计

本文记录 GQLens v1 的业务数据缓存重构设计：移除旧 `NormalizedCache` / `cache` 公共命名，统一使用 `GraphDataStore` / `store`，底层 records 可由外部接管，以支持持久化、LRU、SIEVE 或自定义 TTL。

## 设计决策

- `GraphDataStore` 负责业务语义：field / slot、TTL、invalidation、transaction、signal 通知。
- 底层 records 存储通过 `GraphDataRecords` 注入；默认实现是普通内存 `Map`。
- 外部 records map 基本不主动改写业务数据；写入仍由 GQLens 产生。
- 外部 records map 可以因容量或 TTL 删除 record，但必须通过 `onEvict` 同步通知 GQLens。
- Core 不内置 IndexedDB，不提供浏览器专用包，也不规定持久化格式。
- operation plan cache、completed freshness map、session registry、render/accessor memo 不进入 records map。

## 命名与旧 API 移除

公共命名使用：

- `GraphDataStore`

`normalized` 只描述内部布局，不再作为公共概念。重构目标是移除旧 API，而不是长期保留别名：

- 移除 `NormalizedCache`。
- 移除 `createNormalizedCache()`。
- 移除适配器配置里的 `cache` 命名。
- 统一使用 `GraphDataStore`、`createGraphDataStore()`、`store`。

适配器使用 `store` 命名：

```tsx
<GQLensProvider config={{ store }} />
```

```ts
createQuery({ store });
createMutation(mutation, { store });
```

## Core API

```ts
export interface GraphDataStore {
  entry<T = unknown>(address: GraphDataAddress): FieldSignal<T>;
  peek<T = unknown>(address: GraphDataAddress): FieldSignal<T> | undefined;
  read<T = unknown>(address: GraphDataAddress): T | undefined;
  write<T = unknown>(address: GraphDataAddress, value: T, options?: GraphDataWriteOptions): void;
  isFresh(address: GraphDataAddress): boolean;
  invalidate(target: GraphDataInvalidation | readonly GraphDataInvalidation[]): void;
  transaction<T>(run: (store: GraphDataStore) => T): GraphDataTransaction<T>;
  clear(): void;

  entity(type: string, id: string): EntityRef;
  normalize(data: GraphQLResult, ttl?: number, metadata?: PlannerMetadata): void;
}

export function createGraphDataStore(options?: {
  readonly records?: GraphDataRecords;
}): GraphDataStore;
```

## Records Map

records 分成 `fields` 和 `slots`，与当前 store 结构一致。

```ts
export interface GraphDataRecord {
  readonly value: unknown;
  readonly expires: number;
}

export interface GraphDataRecordMap {
  get(key: string): GraphDataRecord | undefined;
  set(key: string, record: GraphDataRecord): void;
  delete(key: string): boolean;
  clear(): void;
  entries(): Iterable<readonly [string, GraphDataRecord]>;

  onEvict?(listener: (key: string, record: GraphDataRecord) => void): () => void;
}

export interface GraphDataRecords {
  readonly fields: GraphDataRecordMap;
  readonly slots: GraphDataRecordMap;
}
```

普通内存：

```ts
const store = createGraphDataStore({
  records: {
    fields: new Map(),
    slots: new Map(),
  },
});
```

外部容量策略：

```ts
const store = createGraphDataStore({
  records: {
    fields: createLruRecordMap({ max: 10_000 }),
    slots: createSieveRecordMap({ max: 5_000 }),
  },
});
```

## Records Map Contract

外部 records map 必须遵守以下约束：

- `get()` 必须同步返回；字段读取不能 await storage。
- store 创建后，外部不得绕过 GQLens 主动 `set()` 业务数据。
- store 创建后，外部不得静默 `delete()` / `clear()` records。
- `get()` 可以更新 LRU recency，但不能删除 records。
- 写入后的 `GraphDataRecord` 应按不可变数据看待，不要原地修改。
- missing 用 absence 表达，即 `get(key) === undefined`；不要用 `{ value: undefined }`。
- `entries()` 必须反映当前 records，供 clear、invalidation、debug 统计或未来导出使用。
- 自动 eviction 必须同步触发 `onEvict(key, oldRecord)`。
- 没有 `onEvict` 的 map 会被视为稳定普通 map。

违反这些约束会导致 signal 不通知、active reader 继续看到旧值、refetch 不触发、invalidation 漏标 stale 或 optimistic rollback 不完整。

## Freshness 与 Eviction

`expires` 保留现有语义：

- `expires === 0`：永不过期。
- `expires > Date.now()`：fresh。
- `expires <= Date.now()`：stale。
- record 不存在：missing。

stale record 仍可展示，`cache-and-network` 会后台校准。外部 eviction 会把 fresh/stale record 变成 missing；这是外部容量策略的结果，会减少缓存命中和旧值展示机会，但只要 `onEvict` 正确通知，就不会造成静默错误。

active selection 读到 missing 后，仍按现有 query 调度走网络获取，再写回 `GraphDataStore`。

## Signal 与 Transaction

GQLens 自己写入、删除、clear 时，由 `GraphDataStore` 更新 signal。

外部 map 自动 eviction 时，`GraphDataStore` 通过 `onEvict` 将对应 signal 写成 `undefined`，让 reader 重新进入 missing / refetch 流程。

transaction 期间发生的外部 eviction 应纳入 undo。rollback 应恢复 optimistic update 前的可见缓存状态，因此 `onEvict` 必须提供旧 record。

## 持久化

Core 不关心持久化介质。外部可以用 memory-backed records map 封装：

- 浏览器：内存 map + IndexedDB / localStorage / OPFS。
- Node：内存 map + 文件 / SQLite / KV。
- Electron：内存 map + 文件或 SQLite。
- 测试：纯内存 map。

异步持久化 records 必须先加载到内存镜像，再创建 `GraphDataStore`；或者由应用等待 records ready 后再挂载 GQLens provider / query。

```ts
const records = await createAppRecordMaps({
  namespace,
  schemaVersion,
  userScope,
});

const store = createGraphDataStore({ records });
```

恢复的持久化数据建议默认写成 stale：UI 可先读旧值，active selection 随后网络校准；持久化数据不是 fresh source of truth。

不支持 v1 在 GQLens provider / query 已挂载后再异步恢复 records。这样会引入 restore / network / mutation 竞态。应用仍可先渲染不依赖 GQLens 数据的 App Shell。

小数据 records restore 通常不会比首次网络、JS 加载、框架渲染、schema/codegen 成本更成为首屏瓶颈。如果 restore 已经明显影响首屏，问题通常转向分片、懒恢复、增量存储或按 scope 加载；这不属于 v1。

## 不进入 Records Map 的缓存

以下仍由内部独立管理，不走 `GraphDataRecordMap`：

- operation plan cache。
- completed freshness map。
- React / Solid session registry。
- render tracking。
- accessor 局部 memo。
- EntityRef object pool。

这些是运行时派生状态，不是业务数据 records。

## 后续方向

- v1 至少支持原生 `Map<string, GraphDataRecord>`。
- 官方 records map 第一阶段只需要 memory 实现；LRU / SIEVE 等 stats 和真实需求明确后再提供。
- debug stats 可作为 dev-only 能力，例如 fields / slots size、eviction count、hit / miss。
- v1 允许 per-key eviction；partial graph 会变成 cache miss 并触发 refetch。family-aware eviction 等真实 UX 问题出现后再设计。
- 重构应同步清理旧命名、旧文档和适配器旧入口，避免 `cache` / `store` 双轨长期存在。

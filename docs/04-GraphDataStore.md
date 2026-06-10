# 04. GraphDataStore

## 存储模型

缓存的主要单位是**实体字段**，而非整体对象。每个字段由一个 reactive signal 支撑。

```
User:1.name      → Signal<string | undefined>
User:1.avatar    → Signal<string | null | undefined>
User:1.online    → Signal<boolean | undefined>
Todo:9.title     → Signal<string | undefined>
Todo:9.done      → Signal<boolean | undefined>
```

当数据写入 store 时，只有对应字段的 signal 更新；只有读过该字段的组件才会收到通知。

除了实体字段，store 还需要保存 identity slot：

```
Query.viewer                  → Ref<User:1> | null | undefined
Query.todos(done:false).ids   → readonly string[] | undefined
User:1.posts(first:10).ids    → readonly string[] | undefined
Query.search(text:"x").refs   → readonly EntityRef[] | undefined
```

slot 负责表达“这条 GraphQL 路径当前指向谁”；列表 identity 的公开读取值是稳定 ID 数组或 entity ref 数组。实体字段负责表达“这个实体上的某个字段是什么值”。二者分离后，不同路径命中同一实体时才能自然共享字段更新。

示例：服务端返回

```json
{ "user": { "__typename": "User", "id": "1", "name": "Alice" } }
```

写入：

```ts
store.write(
  {
    owner: { kind: "entity", ref: { type: "User", id: "1" } },
    path: [{ field: "name" }],
  },
  "Alice",
);
```

仅通知读过 `q.user({ id: "1" }).name` 的 reader。

## 路径归一

不同 GraphQL 路径命中同一实体时，写入**同一组** field signal。

```graphql
query {
  viewer {
    id
    name
  }
  post(id: "9") {
    author {
      id
      avatar
    }
  }
}
```

若 `viewer` 和 `post.author` 都是 `User:1`：

```
viewer.name          → User:1.name
post.author.avatar   → User:1.avatar
```

之后在任何地方读 `User:1.name` 或 `User:1.avatar`，共享同一个字段级 signal。

路径归一不是丢掉路径信息。root / relation slot 仍保留路径与 args，用来维护列表成员、分页窗口、null relation 等 identity 状态；实体字段则按 `typename + id + field` 去重。

## 深层对象规则

| JSON 结构                     | Store 表现                                   |
| ----------------------------- | -------------------------------------------- |
| 含 `id` + `__typename` 的对象 | entity reference                             |
| entity reference 列表         | slot 上的 `ids` / `refs` 列表 signal         |
| 标量 / enum 字段              | field signal                                 |
| scalar / enum list            | 单个 leaf field signal                       |
| 无 id 的嵌套 object           | 以父 owner 为根递归拆到 embedded leaf signal |

不得将任意运行时 JSON 盲目递归展开为 signal。递归拆分只适用于 schema metadata 已确认的 Value Object；自定义 scalar、JSON scalar 和 scalar list 仍作为单个 leaf field value。

这个规则的重点是保持响应式边界可预测：有 identity 的东西进入 normalized graph；没有 identity 的 schema object 只在父 root/entity/value path 下拥有 embedded address，而不是伪装成全局实体。

非 `id` 的 entity 识别策略不属于当前设计。Value Object 的 embedded address、列表限制和 schema contract 见 [服务端 Schema 设计指南](./服务端-Schema设计指南.md)。

## Store 接口

```ts
interface FieldSignal<T = unknown> {
  readonly sig: Signal<T>;
  expires: number;
}

interface GraphDataRecord {
  readonly value: unknown;
  readonly expires: number;
}

interface GraphDataRecordMap {
  get(key: string): GraphDataRecord | undefined;
  set(key: string, record: GraphDataRecord): void;
  delete(key: string): boolean;
  clear(): void;
  entries(): Iterable<readonly [string, GraphDataRecord]>;

  onEvict?(listener: (key: string, record: GraphDataRecord) => void): () => void;
}

interface GraphDataRecords {
  readonly fields: GraphDataRecordMap;
  readonly slots: GraphDataRecordMap;
}

interface GraphDataStore {
  entry<T = unknown>(address: GraphDataAddress): FieldSignal<T>;
  peek<T = unknown>(address: GraphDataAddress): FieldSignal<T> | undefined;
  read<T = unknown>(address: GraphDataAddress): T | undefined;
  write<T = unknown>(address: GraphDataAddress, value: T, options?: GraphDataWriteOptions): void;
  isFresh(address: GraphDataAddress): boolean;
  invalidate(target: GraphDataInvalidation | readonly GraphDataInvalidation[]): void;
  transaction<T>(run: (store: GraphDataStore) => T): GraphDataTransaction<T>;
  entity(type: string, id: string): EntityRef;
  normalize(data: GraphQLResult, ttl?: number, metadata?: PlannerMetadata): void;
  clear(): void;
}

function createGraphDataStore(options?: { readonly records?: GraphDataRecords }): GraphDataStore;
```

`GraphDataAddress` 是稳定 store 地址：`owner` 表达 root/entity，`path` 表达字段路径，`facet` 表达 relation family：

```ts
type GraphDataFacet = "value" | "link" | "ids" | "refs";
```

- `value`：entity scalar / value-object leaf
- `link`：entity relation base，例如 `User:1.bestFriend`
- `ids` / `refs`：list identity

字符串 store key 只是 store 内部编码细节；公共读写、invalidation、optimistic 写入和 generated runtime 都使用 `GraphDataAddress`。TTL / stale 判断留在 session 调度层处理。

`clear()` 清空所有 field 和 slot 条目，不触动 EntityRef 引用池。适用场景：登出后清除用户数据、路由跳转重置缓存。

默认 records 是内存 `Map`。需要持久化、LRU、SIEVE 或自定义 TTL 时，应用可以注入 `GraphDataRecords`：

```ts
const store = createGraphDataStore({
  records: {
    fields: new Map(),
    slots: new Map(),
  },
});
```

`GraphDataStore` 仍负责业务语义：field / slot、TTL、invalidation、transaction 和 signal 通知；外部 records map 只负责存放 record。Core 不内置 IndexedDB、文件、SQLite 或浏览器专用持久化格式。

外部 records map 必须遵守这些约束：

- `get()` 必须同步返回；字段读取不能等待异步 storage。
- store 创建后，外部不得绕过 GQLens 主动 `set()` 业务数据。
- store 创建后，外部不得静默 `delete()` / `clear()` records。
- `get()` 可以更新 LRU recency，但不能删除 records。
- `GraphDataRecord` 写入后应按不可变数据看待，不要原地修改。
- missing 用 absence 表达，即 `get(key) === undefined`；不要用 `{ value: undefined }`。
- `entries()` 必须反映当前 records，供 `clear()`、invalidation、debug 统计或未来导出使用。
- 自动 eviction 必须同步触发 `onEvict(key, oldRecord)`。
- 没有 `onEvict` 的 map 会被视为稳定普通 map。

违反这些约束会导致 signal 不通知、active reader 继续看到旧值、refetch 不触发、invalidation 漏标 stale 或 optimistic rollback 不完整。

## TTL

store 按字段粒度维护 TTL，采用**惰性驱逐**：

```
User:1.name   → { data: "Alice",  expires: 1717000000 }
User:1.online → { data: true,     expires: 1717000030 }
```

读取时检测 TTL：未过期直接返回；已过期则保留旧值返回、同时后台触发 `cache-and-network` fetch。fetch 完成后覆盖旧值并更新 TTL。

session 通过 `ttl` 配置默认字段 TTL，`0` 表示永不过期。

TTL 的语义是“stale”，不是“删除”。过期值仍可用于当前渲染，只是它对应的 active demand 会被 session 重新拉取。

store 必须保留 missing / null / stale 的区别：

- missing：entry 不存在或 signal 值为 `undefined`
- null：服务端明确写入 `null`
- stale：entry 有值，但 `expires` 已过期

stale entry 不得被读路径当成 missing。读取返回旧值，调度层负责 refetch。

外部 records map 的容量 eviction 与 TTL stale 是两件事。TTL 过期不删除 record；外部 eviction 删除 record 后，该地址从 fresh/stale 变成 missing，active selection 再按正常流程 refetch。

恢复持久化数据时，建议默认写成 stale：UI 可以先读旧值，随后由 active selection 网络校准。异步持久化应先加载到内存镜像，再创建 `GraphDataStore`；GQLens v1 不支持 provider / query 已挂载后再异步恢复 records。

## 一致性

所有写路径最终收敛到同一个 store：

```
query response ─┐
live patch ─────┤
mutation resp ──┼──→ GraphDataStore → FieldSignal → Reader
optimistic ─────┘
```

不允许任何路径绕过 store 直接通知 UI。

这条约束让 query、live、mutation、optimistic update 可以共享同一套冲突和订阅语义。UI 不需要知道数据来自首次请求、后台刷新还是实时推送。

## 派生缓存边界

只有 GraphQL 业务数据进入 `GraphDataRecords`。以下运行时状态可重算，丢弃后不改变 UI 业务语义，因此不持久化，也不进入 records map：

- operation plan cache：selection paths 到 GraphQL operation plan 的 exact SIEVE cache。
- completed freshness map：query session 内已完成 operation 的 freshness 记录。
- React / Solid session registry：adapter 层的 session 复用状态。
- render tracking：当前 render 的 selection 收集状态。
- accessor 局部 memo：访问链上的 child accessor 复用。
- EntityRef object pool：稳定 `{ type, id }` 引用，减少无意义 signal update。

这些状态可以有容量边界或生命周期边界，但不应和业务数据 records 混在一起。需要跨访问恢复的数据只能是 `fields` / `slots` records。

## EntityRef 引用复用

EntityRef（`{ type, id }`）在 normalize、syncSlots、writerRelationSlot 等多条路径被反复创建并写入 slot signal。每个 slot signal 由 alien-signals 驱动；alien-signals 在写入时用 `!==` 判断值是否变化，只在实际变化时通知订阅者。

如果每次创建新 EntityRef 对象，即使 `type` 和 `id` 都相同，`!==` 也会判定为新值，导致无变化的 slot 仍触发通知。因此 store 维护一个模块级 `type:id → EntityRef` 引用池：所有路径创建同一实体的 ref 时返回同一个对象引用。这样同一实体写入同一 slot 时 `!==` 命中旧值，跳过通知。

这条优化只影响 slot signal 更新效率，不改变 store 的任何语义——EntityRef 在全代码库中被当作纯值类型使用，所有读写仅依赖 `type` / `id` 属性，无引用身份依赖。

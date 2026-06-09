# 04. Normalized Cache

## 存储模型

缓存的主要单位是**实体字段**，而非整体对象。每个字段由一个 reactive signal 支撑。

```
User:1.name      → Signal<string | undefined>
User:1.avatar    → Signal<string | null | undefined>
User:1.online    → Signal<boolean | undefined>
Todo:9.title     → Signal<string | undefined>
Todo:9.done      → Signal<boolean | undefined>
```

当数据写入 cache 时，只有对应字段的 signal 更新；只有读过该字段的组件才会收到通知。

除了实体字段，cache 还需要保存 identity slot：

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
cache.write(
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

| JSON 结构                     | Cache 表现                                   |
| ----------------------------- | -------------------------------------------- |
| 含 `id` + `__typename` 的对象 | entity reference                             |
| entity reference 列表         | slot 上的 `ids` / `refs` 列表 signal         |
| 标量 / enum 字段              | field signal                                 |
| scalar / enum list            | 单个 leaf field signal                       |
| 无 id 的嵌套 object           | 以父 owner 为根递归拆到 embedded leaf signal |

不得将任意运行时 JSON 盲目递归展开为 signal。递归拆分只适用于 schema metadata 已确认的 Value Object；自定义 scalar、JSON scalar 和 scalar list 仍作为单个 leaf field value。

这个规则的重点是保持响应式边界可预测：有 identity 的东西进入 normalized graph；没有 identity 的 schema object 只在父 root/entity/value path 下拥有 embedded address，而不是伪装成全局实体。

非 `id` 的 entity 识别策略不属于当前设计。Value Object 的 embedded address、列表限制与后续实现路径见 [精进：Entity 识别策略](./实现/精进-Entity识别策略.md)。

## Cache 接口

```ts
interface FieldSignal<T = unknown> {
  readonly sig: Signal<T>;
  expires: number;
}

interface NormalizedCache {
  entry<T = unknown>(address: CacheAddress): FieldSignal<T>;
  peek<T = unknown>(address: CacheAddress): FieldSignal<T> | undefined;
  read<T = unknown>(address: CacheAddress): T | undefined;
  write<T = unknown>(address: CacheAddress, value: T, options?: CacheWriteOptions): void;
  isFresh(address: CacheAddress): boolean;
  invalidate(target: CacheInvalidation | readonly CacheInvalidation[]): void;
  transaction<T>(run: (cache: NormalizedCache) => T): CacheTransaction<T>;
  entity(type: string, id: string): EntityRef;
  normalize(data: GraphQLResult, ttl?: number): void;
  clear(): void;
}
```

`CacheAddress` 是稳定 cache 地址：`owner` 表达 root/entity，`path` 表达字段路径，`facet` 表达 relation family：

```ts
type CacheFacet = "value" | "link" | "ids" | "refs";
```

- `value`：entity scalar / value-object leaf
- `link`：entity relation base，例如 `User:1.bestFriend`
- `ids` / `refs`：list identity

字符串 cache key 只是 store 内部编码细节；公共读写、invalidation、optimistic 写入和 generated runtime 都使用 `CacheAddress`。TTL / stale 判断留在 session 调度层处理。

`clear()` 清空所有 field 和 slot 条目，不触动 EntityRef 引用池。适用场景：登出后清除用户数据、路由跳转重置缓存。

## TTL

cache 按字段粒度维护 TTL，采用**惰性驱逐**：

```
User:1.name   → { data: "Alice",  expires: 1717000000 }
User:1.online → { data: true,     expires: 1717000030 }
```

读取时检测 TTL：未过期直接返回；已过期则保留旧值返回、同时后台触发 `cache-and-network` fetch。fetch 完成后覆盖旧值并更新 TTL。

session 通过 `ttl` 配置默认字段 TTL，`0` 表示永不过期。

TTL 的语义是“stale”，不是“删除”。过期值仍可用于当前渲染，只是它对应的 active demand 会被 session 重新拉取。

cache 必须保留 missing / null / stale 的区别：

- missing：entry 不存在或 signal 值为 `undefined`
- null：服务端明确写入 `null`
- stale：entry 有值，但 `expires` 已过期

stale entry 不得被读路径当成 missing。读取返回旧值，调度层负责 refetch。

## 一致性

所有写路径最终收敛到同一个 cache：

```
query response ─┐
live patch ─────┤
mutation resp ──┼──→ NormalizedCache → FieldSignal → Reader
optimistic ─────┘
```

不允许任何路径绕过 cache 直接通知 UI。

这条约束让 query、live、mutation、optimistic update 可以共享同一套冲突和订阅语义。UI 不需要知道数据来自首次请求、后台刷新还是实时推送。

## EntityRef 引用复用

EntityRef（`{ type, id }`）在 normalize、syncSlots、writerRelationSlot 等多条路径被反复创建并写入 slot signal。每个 slot signal 由 alien-signals 驱动；alien-signals 在写入时用 `!==` 判断值是否变化，只在实际变化时通知订阅者。

如果每次创建新 EntityRef 对象，即使 `type` 和 `id` 都相同，`!==` 也会判定为新值，导致无变化的 slot 仍触发通知。因此 cache 维护一个模块级 `type:id → EntityRef` 引用池：所有路径创建同一实体的 ref 时返回同一个对象引用。这样同一实体写入同一 slot 时 `!==` 命中旧值，跳过通知。

这条优化只影响 slot signal 更新效率，不改变 cache 的任何语义——EntityRef 在全代码库中被当作纯值类型使用，所有读写仅依赖 `type` / `id` 属性，无引用身份依赖。

# 04. Normalized Cache

## 存储模型

缓存的单位是**实体字段**，而非整体对象。每个字段由一个 reactive signal 支撑。

```
User:1.name      → Signal<string>
User:1.avatar    → Signal<string | null>
User:1.online    → Signal<boolean>
Todo:9.title     → Signal<string>
Todo:9.done      → Signal<boolean>
```

当数据写入 cache 时，只有对应字段的 signal 更新；只有读过该字段的组件才会收到通知。

示例：服务端返回

```json
{ "user": { "__typename": "User", "id": "1", "name": "Alice" } }
```

写入：

```ts
cache.field({ type: "User", id: "1" }, "name").set("Alice")
```

仅通知读过 `q.user({ id: "1" }).name()` 的 reader。

## 路径归一

不同 GraphQL 路径命中同一实体时，写入**同一组** field signal。

```graphql
query {
  viewer { id name }
  post(id: "9") { author { id avatar } }
}
```

若 `viewer` 和 `post.author` 都是 `User:1`：

```
viewer.name          → User:1.name
post.author.avatar   → User:1.avatar
```

之后在任何地方读 `User:1.name` 或 `User:1.avatar`，共享同一个字段级 signal。

## 深层对象规则

| JSON 结构                   | Cache 表现              |
| --------------------------- | ----------------------- |
| 含 `id` + `__typename` 的对象 | entity reference      |
| entity reference 列表       | ID 列表 signal          |
| 标量字段                    | field signal            |
| 无 id 的嵌套 JSON           | 单个 field signal（不递归分解）|

不应将任意深层对象递归展开为 signal。

## Cache 接口

```ts
interface NormalizedSignalCache {
  field(ref: EntityRef, key: string): Signal<unknown>
  entity(type: string, id: string): EntityRef
  normalize(data: GraphQLResult): void
  invalidate(ref: EntityRef, keys?: string[]): void
}
```

## 一致性

所有写路径最终收敛到同一个 cache：

```
query response ─┐
live patch ─────┤
mutation resp ──┼──→ NormalizedCache → FieldSignal → Reader
optimistic ─────┘
```

不允许任何路径绕过 cache 直接通知 UI。

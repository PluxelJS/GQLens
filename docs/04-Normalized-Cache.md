# 04. Normalized Cache

## 存储模型

缓存的主要单位是**实体字段**，而非整体对象。每个字段由一个 reactive signal 支撑。

```
User:1.name      → Signal<string>
User:1.avatar    → Signal<string | null>
User:1.online    → Signal<boolean>
Todo:9.title     → Signal<string>
Todo:9.done      → Signal<boolean>
```

当数据写入 cache 时，只有对应字段的 signal 更新；只有读过该字段的组件才会收到通知。

除了实体字段，cache 还需要保存 identity slot：

```
Query.viewer                  → Ref<User:1>
Query.todos(done:false).ids   → Ref<Todo:1>[]
User:1.posts(first:10).ids    → Ref<Post:10>[]
```

slot 负责表达“这条 GraphQL 路径当前指向谁”，实体字段负责表达“这个实体上的某个字段是什么值”。二者分离后，不同路径命中同一实体时才能自然共享字段更新。

示例：服务端返回

```json
{ "user": { "__typename": "User", "id": "1", "name": "Alice" } }
```

写入：

```ts
cache.field({ type: "User", id: "1" }, "name").set("Alice");
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

| JSON 结构                     | Cache 表现                      |
| ----------------------------- | ------------------------------- |
| 含 `id` + `__typename` 的对象 | entity reference                |
| entity reference 列表         | slot 上的 ID 列表 signal        |
| 标量字段                      | field signal                    |
| 无 id 的嵌套 JSON             | 单个 field signal（不递归分解） |

不应将任意深层对象递归展开为 signal。

这个规则的重点是保持响应式边界可预测：有 identity 的东西进入 normalized graph；没有 identity 的嵌套对象被当成字段值，而不是伪装成实体。

## Cache 接口

```ts
interface NormalizedSignalCache {
  field(ref: EntityRef, key: string): Signal<unknown>;
  entity(type: string, id: string): EntityRef;
  normalize(data: GraphQLResult): void;
  invalidate(ref: EntityRef, keys?: string[]): void;
}
```

## TTL

cache 按字段粒度维护 TTL，采用**惰性驱逐**：

```
User:1.name   → { data: "Alice",  expires: 1717000000 }
User:1.online → { data: true,     expires: 1717000030 }
```

读取时检测 TTL：未过期直接返回；已过期则保留旧值返回、同时后台触发 `cache-and-network` fetch。fetch 完成后覆盖旧值并更新 TTL。

用户通过 `useQuery({ ttl })` 配置默认 TTL，`0` 表示永不过期。

TTL 的语义是“stale”，不是“删除”。过期值仍可用于当前渲染，只是它对应的 active demand 会被 session 重新拉取。

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

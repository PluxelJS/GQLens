# 服务端 Schema 设计指南

这份文档记录服务端为了配合 GQLens GraphDataStore 需要遵守的 GraphQL schema contract。目标是让客户端保持稳定、显式、低配置：GQLens 不配置 identity policy，不推断 composite key，也不把任意 `ID!` 字段当成对象身份。

## 核心规则

需要进入 GQLens entity graph 的 object 必须暴露：

```graphql
id: ID!
```

GQLens 的 entity cache key 是：

```text
<ConcreteType>:<id>
```

因此服务端要保证同一个 concrete type 内：

- `id` 稳定。
- `id` 非空。
- `id` 不因名称、排序、分页位置、展示字段变化而改变。
- `id` 不复用给同类型的另一个逻辑对象。
- `id` 可以是 opaque string；客户端不解析它。

全局唯一 ID 可以使用，但不是必须。GQLens cache key 已包含 concrete type，所以 `User:1` 和 `Team:1` 不冲突。

## Composite Key

如果业务对象的真实身份是 composite key，服务端负责 canonicalize 成单个 `id: ID!`。

```graphql
type Membership {
  id: ID! # canonical userId + groupId
  userId: ID!
  groupId: ID!
  role: String!
}
```

客户端只把它当 opaque ID：

```text
Membership:<id>.role
```

不要让 GQLens 推断：

```graphql
type Membership {
  userId: ID!
  groupId: ID!
  role: String!
}
```

这类 schema 没有显式对象身份。GQLens 会把它视为 Value Object；如果它出现在 object list 或 abstract possible type 中，codegen 应报错。

## 不要用 ID 类型暗示身份

`ID!` 类型本身不等于当前 object 的 identity。

```graphql
type AuditEvent {
  actorId: ID!
  requestId: ID!
  message: String!
}
```

`actorId` 和 `requestId` 都是 ID，但都不是 `AuditEvent` 的身份。需要 GraphDataStore 时应显式暴露：

```graphql
type AuditEvent {
  id: ID!
  actorId: ID!
  requestId: ID!
  message: String!
}
```

同理，不要用 `name: ID!`、`slug: ID!`、`key: ID!` 暗示 identity。若它就是业务身份，也应额外暴露 `id: ID!`。

## Value Object

没有 `id` 的 schema object 是 Value Object。它只适合表达嵌入结构：

```graphql
type User {
  id: ID!
  status: UserStatus!
}

type UserStatus {
  online: Boolean!
  source: StatusSource!
}

type StatusSource {
  kind: String!
  version: String
}
```

GQLens 会把 leaf field 写到父 owner 下：

```text
User:1.status.online
User:1.status.source.kind
```

Value Object 不拥有独立 ref，不参与 `.ids` / `.refs`，也不生成 entity invalidation spec。

## Object List

GraphQL object list 的 item 必须是 Entity Object。

```graphql
type Query {
  users: [User!]!
}

type User {
  id: ID!
  name: String!
}
```

不要返回 Value Object list：

```graphql
type Query {
  summaries: [Summary!]! # 不适合 GQLens object list accessor
}

type Summary {
  total: Int!
}
```

原因是 Value Object list 没有稳定 row key，无法表达 `.ids`，也无法稳定处理 reorder、insert、delete。

如果列表元素确实需要作为行读取、更新或失效，应给元素建模为 Entity：

```graphql
type Summary {
  id: ID!
  total: Int!
}
```

如果只是不可分解的值列表，使用 scalar / enum list：

```graphql
type PluginGroup {
  id: ID!
  pluginIds: [String!]!
}
```

## Abstract Type

interface / union 字段或列表只有在所有 possible concrete types 都是 Entity Object 时才适合 GQLens accessor。

```graphql
union SearchResult = User | Post

type User {
  id: ID!
  name: String!
}

type Post {
  id: ID!
  title: String!
}
```

abstract list 暴露 `.refs`，每个 ref 需要 concrete type + id：

```text
[{ type: "User", id: "1" }, { type: "Post", id: "1" }]
```

不要混合 entity 和 value object：

```graphql
union SearchResult = User | Summary # Summary 没有 id，不适合
```

## Root Field

返回 Entity Object 的 root field 最好提供 `id` 参数：

```graphql
type Query {
  user(id: ID!): User
}
```

这样 accessor 可以在 root slot 尚未返回前直接定位 entity field：

```ts
q.user({ id }).name;
```

如果服务端只能通过其他参数查找 entity，也可以返回有 `id` 的 object，但这不应被理解为 identity policy：

```graphql
type Query {
  plugin(name: String!): Plugin
}

type Plugin {
  id: ID!
  name: String!
}
```

此时 cache identity 仍然是 `Plugin:<id>`，不是 `Plugin:<name>`。

## Mutation 返回值

会写入 GraphDataStore 的 mutation response 应返回 Entity Object 的 `id` 和必要字段。GQLens planner / generated mutation selection 应自动补齐 identity fields，但服务端 resolver 必须能稳定返回它们。

```graphql
type Mutation {
  renameUser(id: ID!, name: String!): User!
}
```

返回：

```json
{
  "__typename": "User",
  "id": "1",
  "name": "Alice"
}
```

如果 mutation 改变列表成员或排序，应通过客户端 selector invalidation 失效对应 list identity，而不是只更新 row field。

## Nullability

对象字段可以 nullable，表示查询结果不存在：

```graphql
type Query {
  user(id: ID!): User
}
```

但 Entity Object 自身的 `id` 字段必须 non-null：

```graphql
type User {
  id: ID!
  name: String!
}
```

不要写：

```graphql
type User {
  id: ID
  name: String!
}
```

nullable `id` 会让 cache address 无法稳定生成。

## Checklist

设计或修改服务端 schema 时检查：

- 需要 GraphDataStore 的 object 是否有 `id: ID!`。
- composite identity 是否已经由服务端编码成 opaque `id`。
- object list item 是否都是有 `id` 的 Entity Object。
- abstract possible concrete types 是否全部有 `id`。
- Value Object 是否只作为嵌入结构使用。
- 自定义 JSON scalar 是否被当作单个字段值，而不是 schema object。
- root entity field 是否尽量提供 `id` 参数。
- mutation response 是否能返回稳定 `id`。
- 名称、slug、排序、分页位置变化是否不会改变 `id`。

如果某个类型无法满足这些规则，它应先作为 Value Object 或 scalar payload 设计；需要进入 normalized graph 时再显式补 `id: ID!`。

## Object Kind

GQLens 只把两类 object 进入 normalized graph：

- `Entity Object`：concrete object type 且有非空 scalar `id`
- `Value Object`：concrete object type 且没有 `id`

`interface` / `union` 只有在所有 possible concrete types 都是 `Entity Object` 时才适合 GQLens accessor。混合 entity / value 的 abstract type 不应进入 object list 或 abstract list 语义。

这条规则决定了：

- entity field 写入共享 `Type:<id>` 地址
- value object 只沿父 owner 写入 embedded leaf
- object list 需要稳定 row identity，因此 item 必须是 `Entity Object`
- abstract list 只能暴露 `.refs`

GQLens 不提供 composite key policy；服务端如果需要复合身份，仍应把它 canonicalize 成 opaque `id: ID!`。

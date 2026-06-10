# 精进：Entity 识别策略

这份文档定案 GQLens 的 object identity 模型。目标不是覆盖所有 GraphQL schema 形态，而是让 accessor API、cache 地址、invalidation 和 LLM 推理都保持稳定、显式、低配置。

核心结论：

```text
concrete object type 有非空 scalar id 字段 -> Entity Object
concrete object type 没有 id 字段             -> Value Object
object list item 必须是 Entity Object
abstract object 只有 possible concrete types 全是 Entity Object 时才进入 identity 模型
```

GQLens 不引入外部 identity policy，不支持用 `name`、`slug`、`groupId` 或 composite fields 作为内建 entity key。应用如果希望某个 object 进入 normalized graph，应在 GraphQL schema 中暴露稳定的 `id` 字段。

如果业务 identity 本身是 composite key，GQLens 仍然不理解 composite 规则。服务端应把 composite identity canonicalize 成一个稳定、opaque 的 `id: ID!`，并按需继续暴露组成字段作为普通业务字段。

```graphql
type Membership {
  id: ID! # canonical userId + groupId
  userId: ID!
  groupId: ID!
  role: String!
}
```

这样 GQLens 的 cache、accessor、invalidation 和 LLM 推理都只需要面对一条规则：

```text
Membership:<id>.role
```

服务端 schema 落地清单见 [服务端 Schema 设计指南](../服务端-Schema设计指南.md)。

## 设计目标

Entity 识别必须同时服务四个层面：

- **Accessor API**：字段链只表达 schema-generated contract，不暴露动态 identity 配置。
- **Cache 地址**：同一逻辑对象跨路径写入同一 field signal；无 identity 的对象保持嵌入语义。
- **Invalidation**：entity invalidation 只命中全局 entity；path invalidation 覆盖 root、relation、embedded leaf。
- **LLM 推理**：一眼能判断某个 GraphQL object 是 entity 还是 value object，不需要搜索客户端配置。

因此 identity 是 schema contract，不是 client-side policy。

## Object 分类

### Entity Object

Entity Object 是有稳定 `id` 的 concrete GraphQL object type。

```graphql
type User {
  id: ID!
  name: String!
  avatar: String
}
```

规则：

```text
id field exists
id field is non-null
id field unwrap 后是 scalar
```

推荐写法是 `id: ID!`。实现可以兼容 `id: String!`，但文档、示例和诊断都应推动 schema 使用 GraphQL `ID`。

运行时 ref：

```ts
type EntityRef = {
  readonly type: string;
  readonly id: string;
};
```

地址：

```text
User:1.name
User:1.avatar
```

### Value Object

Value Object 是没有 `id` 的 concrete GraphQL object type。它没有全局 ref，只存在于所属 root path、entity field 或另一个 value object 下。

```graphql
type UserStatus {
  online: Boolean!
  source: StatusSource!
}

type StatusSource {
  kind: String!
  version: String
}
```

读取：

```ts
q.user({ id }).status.online;
q.user({ id }).status.source.kind;
```

地址：

```text
User:1.status.online
User:1.status.source.kind
```

Value Object 不参与 `.ids` / `.refs`，不生成 entity invalidation spec，也不跨父级或跨路径共享字段值。同一个 value object payload 从两个路径出现，写入两个不同 embedded address。

### Abstract Object

`interface` / `union` 本身不是 Entity Object。它只是一组 possible concrete object types 的访问入口。

GQLens 支持 abstract object 的条件：

```text
all possible concrete types are Entity Object
```

否则 codegen 报错。GQLens 不生成混合 entity/value 的 abstract accessor，因为 `$on` 分支、cache owner、list identity 和 invalidation target 会变得不稳定。

```graphql
interface Pet {
  id: ID!
  name: String!
}

type Cat implements Pet {
  id: ID!
  name: String!
  meows: Boolean!
}

type Dog implements Pet {
  id: ID!
  name: String!
  barks: Boolean!
}
```

单个 abstract relation：

```ts
q.pet({ id }).$on.Cat.meows;
```

abstract list：

```ts
q.search({ text }).refs;
```

`.refs` 的元素必须携带 concrete `type + id`，避免 `User:1` 与 `Post:1` 冲突。

## Cache 地址模型

GQLens 使用三类稳定 owner。

```ts
type GraphDataOwner =
  | { readonly kind: "entity"; readonly ref: EntityRef }
  | { readonly kind: "root"; readonly root: string; readonly steps: readonly SelectionStep[] }
  | {
      readonly kind: "embedded";
      readonly owner: GraphDataOwner;
      readonly path: readonly SelectionStep[];
    };
```

这是概念模型，不要求 runtime 直接暴露这个 TypeScript 类型。它的作用是统一 accessor、normalizer、freshness 和 invalidation 的推理方式。

### Entity field address

```text
owner = entity(User:1)
field = name
address = User:1.name
```

跨路径返回同一 entity 时写入同一 address。

```text
Query.viewer.name
Query.post(id:"9").author.name

-> User:1.name
```

### Relation slot address

Relation slot 保存某个 path 当前指向哪个 identity，不保存目标字段值。

```text
Query.user({"id":"1"}) -> User:1
Post:9.author          -> User:1
```

列表 slot 保存成员和顺序：

```text
Query.users.ids     -> ["1", "2"]
Query.search.refs   -> [{ type: "User", id: "1" }, { type: "Post", id: "9" }]
User:1.posts.ids    -> ["9", "10"]
```

slot 和 field signal 分离后，列表成员变化不会污染行字段订阅。

### Embedded field address

Value Object 沿用父 owner，追加 embedded path。

```text
User:1.status.online
User:1.status.source.kind
Query.pluginStatus.summary.total
```

Value Object leaf 是字段级 signal，而不是一个大 JSON signal。这样 `status.online` 更新不会唤醒只读取 `status.source.kind` 的 reader。

Value Object relation 本身只推进 embedded path，不产生 slot：

```ts
q.user({ id }).status.source.kind;
```

```text
owner = entity(User:1)
embedded path = status.source
field = kind
address = User:1.status.source.kind
```

## Accessor Surface

### Entity root

有 `id` 参数的 root accessor 可以在 root slot 尚未返回前直接定位 entity ref：

```ts
q.user({ id }).name;
```

读取语义：

```text
demand Query.user(id).name
read User:<id>.name when root slot is not known null
```

必须保留优先级：

```text
cached root slot value > args inferred entity ref
cached null root slot  > args inferred entity ref
```

如果服务端已经返回 `Query.user(id:"1") = null`，accessor 不能因为 `User:1.name` 仍在 cache 中就显示旧数据。

### Entity relation

Entity relation 先通过 relation slot 定位目标 entity，再读取目标字段：

```ts
q.post({ id }).author.name;
```

```text
Post:9.author -> User:1
User:1.name
```

### Value Object relation

Value Object relation 不产生 entity ref，也不产生 slot，只推进 embedded owner：

```ts
q.user({ id }).status.source.kind;
```

```text
User:1.status.source.kind
```

### Entity list

GQLens 的 object list API 是 identity-first，而不是 object-array-first。

```ts
const ids = q.users.ids;
const name = q.user({ id: ids[0] }).name;
```

普通 object list 的 item 必须是 Entity Object：

```graphql
type Query {
  users: [User!]! # OK: User has id
}
```

Value Object list 不生成 accessor，codegen 必须报错：

```graphql
type Query {
  summaries: [Summary!]! # Error: Summary has no id
}

type Summary {
  total: Int!
}
```

原因：

- index-based cache 在 reorder、insert、delete 后不稳定。
- value object list 没有 row key，无法生成 `.ids`。
- 行字段无法通过 root accessor 重新进入。
- mutation invalidation 无法精确定位某一行。

允许的无 id 列表只有 scalar / enum list：

```graphql
type PluginGroup {
  id: ID!
  pluginIds: [String!]!
}
```

scalar / enum list 作为普通 leaf field value 处理，不生成 `.ids` 伪字段。

### Root lookup 设计边界

Entity Object 有 `id` 不等于必须为这个 type 暴露 root lookup。Root lookup 的职责是提供一个稳定、可跨路径回读的入口；它应该属于领域里的 aggregate root 或常用导航入口，而不是为了每个嵌套状态、边信息、派生视图都额外造 query。

推荐：

```graphql
type Query {
  plugin(id: ID!): Plugin!
  plugins: [Plugin!]!
}

type Plugin {
  id: ID!
  name: String!
  status: PluginStatus!
  detail: PluginDetail!
  dependencies: [Plugin!]!
}

type PluginStatus {
  isRunning: Boolean!
  isEnabled: Boolean!
}

type PluginDetail {
  dependencies: [Plugin!]!
}
```

这里 `Plugin` 是 entity 和 root lookup 对象；`PluginStatus` / `PluginDetail` 是隶属于 `Plugin` 的 Value Object；`dependencies` 是 plugin-to-plugin relation，而不是额外制造 `PluginDependency(id)` root。

不推荐：

```graphql
type Query {
  pluginStatusEntry(id: ID!): PluginStatusEntry!
  pluginDependency(id: ID!): PluginDependency!
}
```

这种 schema 把状态快照和关系边误建模为独立 aggregate root，会扩大 API 面、增加 invalidation 入口，并让 LLM 误以为这些对象有独立生命周期。

对 GQLens 而言，entity list 的 `.ids` 可以通过已有 aggregate root 回读：

```ts
const ids = q.plugins.ids ?? [];
const firstStatus = q.plugin({ id: ids[0] }).status;
const dependencyIds = q.plugin({ id: ids[0] }).dependencies.ids ?? [];
const firstDependencyName = q.plugin({ id: dependencyIds[0] }).name;
```

如果某个 entity type 经常出现在列表中，却没有任何 root 或 relation 能按 id 回读它，schema 作者应该优先审视领域模型：它究竟是 aggregate root、已有 entity 的 relation，还是应该退回 scalar id list / value object。

### Abstract list

interface / union list 只暴露 `.refs`。所有 possible concrete object type 都必须是 Entity Object。

```graphql
union SearchResult = User | Post
```

```ts
const refs = q.search({ text }).refs;
```

GQLens 不生成混合 entity/value 的 abstract list API。

## Planner

Planner 必须消费 codegen metadata，不通过 JS 值猜测 GraphQL 类型。

建议 metadata 分层：

```ts
type ObjectKind = "entity" | "value";

type ObjectMeta = {
  readonly type: string;
  readonly kind: ObjectKind;
  readonly fields: Readonly<Record<string, FieldMeta>>;
};

type FieldMeta = {
  readonly name: string;
  readonly kind: "scalar" | "object" | "list";
  readonly targetType?: string;
  readonly targetObjectKind?: ObjectKind;
  readonly isAbstract?: boolean;
  readonly possibleTypes?: readonly string[];
  readonly hasArgs?: boolean;
};
```

Planner 行为：

- Entity Object selection 自动补齐 `id` 和 `__typename`。
- Value Object selection 不补 `id`。
- abstract entity selection 补 `__typename`，并在 possible concrete type 分支内补 `id`。
- list identity pseudo-field 不渲染成 GraphQL 字段。

```ts
q.users.ids;
```

渲染为：

```graphql
users {
  id
  __typename
}
```

```ts
q.user({ id }).status.online;
```

渲染为：

```graphql
user(id: $id) {
  id
  __typename
  status {
    online
  }
}
```

## Normalizer

Normalizer 必须由 schema metadata 驱动，不再用 `__typename + id` 作为唯一运行时猜测规则。

Entity object 写入：

```json
{
  "__typename": "User",
  "id": "1",
  "name": "Alice"
}
```

```text
Query.user({"id":"1"}) -> User:1
User:1.id
User:1.__typename
User:1.name
```

Value Object 写入：

```json
{
  "status": {
    "online": true,
    "source": { "kind": "hmr" }
  }
}
```

如果父 owner 是 `User:1`：

```text
User:1.status.online
User:1.status.source.kind
```

如果父 owner 是 root path：

```text
Query.pluginStatus.summary.total
```

object list normalize 要求 item 是 Entity Object。Value Object list 应在 codegen 阶段失败；runtime 在开发环境可以报错，在生产环境跳过 list identity slot 写入并保留诊断入口。

## Freshness

cache-first freshness 只判断被读取的稳定 address。

| 读取形态                       | fresh 判断                                                                 |
| ------------------------------ | -------------------------------------------------------------------------- |
| `q.user({ id }).name`          | fresh root null 直接命中；fresh root ref 或 args ref 再检查 `User:id.name` |
| `q.post({ id }).author.name`   | `Post:id.author` slot fresh 且 `User:id.name` fresh                        |
| `q.user({ id }).status.online` | root/entity owner 可解析，且 `User:id.status.online` fresh                 |
| `q.users.ids`                  | `Query.users.ids` fresh                                                    |
| `q.search.refs`                | `Query.search.refs` fresh                                                  |

root slot 的 null 优先级必须高于 args inferred entity ref。这样服务端返回 null 后，不会从旧 entity field 中读出过期数据。

## Invalidation

### Entity invalidation

Entity invalidation 只覆盖 Entity Object：

```ts
{
  kind: "entity",
  ref: { type: "User", id },
  paths: [[{ field: "name" }]],
}
```

entity invalidation target 只覆盖 Entity Object。Value Object 不生成独立 entity target。

如果需要失效 value object leaf，有两种方式：

```ts
// 父 entity 的嵌入字段 key
{
  kind: "entity",
  ref: { type: "User", id },
  paths: [[{ field: "status" }, { field: "online" }]],
}

// selector target
defineInvalidation((q) => q.user({ id }).status.online);
```

selector invalidation 更适合表达 root path、relation slot、list identity 和 embedded leaf。

### List invalidation

列表成员或排序变化必须 invalidate list identity，而不是猜测每个 row field：

```ts
defineInvalidation((q) => q.users.ids);
defineInvalidation((q) => q.search({ text }).refs);
```

## Codegen Diagnostics

codegen 必须把 schema contract 问题提前暴露。

必须报错：

- object list item 没有 `id`。
- interface / union field 或 list 的 possible type 中存在无 `id` object。
- object type 声明了 `id` 但 `id` nullable。
- object type 声明了 `id` 但 `id` 不是 scalar。
- abstract possible type 混合 entity object 和 value object。

建议警告：

- `id` 使用 `String!` 而不是 `ID!`。
- root field 通过非 `id` 参数查 entity，例如 `plugin(name: String!)` 返回有 `id` 的 `Plugin`。这可以工作，但如果业务上 `name` 就是 identity，schema 更清晰的写法是 `plugin(id: ID!)` 或同时暴露 `id`。

不要提供 codegen option 去消除这些错误。GQLens 的目标是让 schema contract 本身稳定，而不是用客户端配置修补 schema。

## 实现路径

### 1. Codegen 分类 object

为 concrete object 生成 `ObjectKind`：

```text
has non-null scalar id field -> entity
no id field                  -> value
```

为 abstract type 生成 possible concrete type 列表，并验证所有 possible type 都是 entity。

### 2. Metadata 重命名

把当前容易混淆的 `returnsEntity` 拆成两个概念：

```text
returns object/composite?
target object kind is entity/value?
```

Accessor、Planner、Session、Normalizer 都消费同一份 metadata。

### 3. Accessor 支持 embedded owner

- Entity object：生成 entity accessor。
- Value Object：生成 embedded accessor。
- Entity list：生成 `.ids` 或 `.refs`。
- Value Object list：诊断失败，不生成 accessor。
- scalar / enum list：作为 leaf field value。

### 4. Planner 按 ObjectKind 补 identity fields

只对 Entity Object 补 `id + __typename`。Value Object 不补 `id`。

### 5. Normalizer 改为 metadata-driven

Normalizer 不再只靠 payload 是否含 `__typename + id` 判断 entity。它根据 field metadata 判断目标 object kind：

```text
Entity Object -> EntityRef + entity field signals + relation/list slots
Value Object  -> embedded leaf field signals
```

### 6. Session / freshness 使用统一 address

cache-first freshness 需要能判断 entity field、root slot、relation slot、list identity 和 embedded leaf。不要在 session 里手写多套 path 推断；应通过统一 address resolver 从 selection path 得到待检查地址。

### 7. Invalidation 收口

typed entity invalidation 只由 Entity Object 生成。selector invalidation 覆盖 root、relation、list identity 和 embedded leaf。

## 非目标

以下能力暂不设计：

- 非 `id` entity key。
- composite key。
- singleton strategy。
- schema directive / codegen option identity policy。
- index-based object list accessor。
- mixed entity/value abstract accessor。

如果应用需要 singleton，也应在 schema 中暴露一个稳定 `id`：

```graphql
type PluginStatusOverview {
  id: ID!
  summary: PluginStatusSummary!
}
```

例如返回固定值 `"current"`。这样 singleton 仍然复用同一套 Entity 规则，而不是引入第三种 identity 机制。

## 与 GQty 的关系

GQLens 继续保留 GQty 的核心洞见：

```text
field read -> declare selection demand
cache miss/stale -> active demand drives fetch
```

但 GQLens 不暴露 data proxy object，也不让 object array 成为读取体验中心。GQLens 的公开边界是：

```text
scalar / enum leaf field signal
embedded value leaf field signal
entity list identity
schema-generated accessor
```

因此 entity 识别必须比 GQty 更显式。`id` 是 schema-level contract；没有 `id` 的 object 就是 value object，不进入 normalized graph。

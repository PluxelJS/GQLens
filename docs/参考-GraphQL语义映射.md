# GraphQL 语义映射

本章记录 GraphQL 语言特性在 GQLens 中的落点。原则是：schema 决定 accessor shape；runtime 只执行已生成的语义；无法稳定映射为字段访问的能力，放到 Planner、Cache 或 Transport 层。

## 映射总表

| GraphQL 特性             | GQLens 映射                                                                      |
| ------------------------ | -------------------------------------------------------------------------------- |
| field                    | 无参字段 getter；有参字段函数                                                    |
| arguments / input object | plain args；canonical key；prepared selection 中用 `v("name")` 占位              |
| variables                | Planner 自动提取；用户不在 runtime accessor 上手写 `$var`                        |
| alias                    | Planner 内部生成，用户 accessor 不暴露 alias API                                 |
| object type              | 有非空 scalar `id` 是 Entity；无 `id` 是 Value Object                            |
| scalar / enum            | 读取终点；类型由 GraphQL Code Generator 映射                                     |
| custom scalar            | 作为字段值处理；序列化/反序列化属于 codegen 或 transport 边界                    |
| list                     | 普通 entity list 暴露 `ids`；abstract list 暴露 `refs`                           |
| connection               | list identity + `pageInfo`；edge/node 字段不得混成 entity array                  |
| interface / union        | 共同字段直接访问；类型分支通过 `$on.<TypeCondition>`                             |
| inline fragment          | `$on.<TypeCondition>` 或 prepared selection 内的同一 accessor path               |
| named fragment           | `defineSelection()` 复用，不生成新的 runtime 字段语义                            |
| `__typename`             | 普通字段读取；Planner 可为 identity 自动补齐                                     |
| directive                | 默认不暴露字段级 directive API；条件需求优先用宿主控制流表达                     |
| nullability              | `null` 表示服务端 null；`undefined` 表示 missing / 分支不适用                    |
| partial error            | data 仍写 store；GraphQL errors 进入 session error 状态                          |
| subscription             | 可作为 `LiveSubscriber` 的一种实现；不等同于所有 reactive query                  |
| defer / stream           | 增量 payload 写入同一 cache；调度策略可扩展，accessor shape 不变化               |
| schema directive         | 只影响 generated contract 或外部策略提示；例如 deprecated、auth hint、cache hint |

## Alias

用户不需要也不应手写 alias：

```ts
q.user({ id: "1" }).name;
q.user({ id: "2" }).name;
```

同一字段不同 args 由 Planner 自动生成 alias。alias 是 operation 序列化细节，不是 accessor graph 的一部分。把 alias 暴露到 API 会让 cache key、selection path 和用户命名耦合，破坏 canonical merge。

## Directive

GQLens 不应急于提供：

```ts
q.user({ id }).name.$include(cond);
q.user({ id }).name.$skip(cond);
```

render-time discovery 已经能用宿主控制流表达条件需求：

```ts
if (showName) {
  q.user({ id }).name;
}
```

reader 的 active selection 会在下一次 render 替换，因此条件变化可以自然 diff。prepared selection 若需要条件变量，应设计成显式 selection variant 或专门的 typed condition primitive；不能把任意 directive 链接到字段 getter 后面。

schema directive 只能进入 generated contract 或外部策略提示。例如：

- `@deprecated` → TSDoc / lint 诊断
- auth / cache hint → operation options 或 policy hint

它们不改变字段访问形态，也不配置 entity identity。GQLens 的内建 identity contract 只认 schema object 上的非空 scalar `id` 字段。

## Fragment

GQLens 不把 fragment 当作第二套 query 语言。

inline fragment 映射为 `$on.<TypeCondition>`：

```ts
q.pet({ id }).$on.Cat.meows;
```

named fragment 映射为可复用 prepared selection：

```ts
const userCard = defineSelection((q, v) => {
  q.user({ id: v("id") }).name;
  q.user({ id: v("id") }).avatar;
});
```

这保持了同一个 accessor graph：fragment 只是 selection 复用和提前规划的单位，不是运行时数据对象。

## Interface / Union

抽象类型有三条规则：

- common field 直接访问
- type-specific field 通过 `$on.<TypeCondition>` 访问
- abstract list identity 使用 `refs`，不能只用 `ids`

```ts
q.pet({ id }).name;
q.pet({ id }).$on.Cat.meows;
q.search({ text }).refs;
```

`refs` 的元素是 entity reference，至少包含 concrete type 和 `id`。这样 `User:1` 与 `Team:1` 不会冲突。

读取 abstract list 行字段时，调用方根据 `ref.__typename` 进入具体 root accessor，或进入 schema 已定义的 abstract root accessor 后使用 `$on`。列表本身仍只表达成员与顺序。

分支不匹配时返回 `undefined`。这表示 branch not applicable，不是 GraphQL null。

## Nullability 与 Error

字段读取必须区分：

| 情况                 | 返回 / 状态              |
| -------------------- | ------------------------ |
| cache missing        | `undefined`              |
| 分支不适用           | `undefined`              |
| 服务端返回 null      | `null`                   |
| stale                | 返回旧值，并触发 refetch |
| GraphQL partial data | 写入 data；errors 进状态 |
| transport failure    | 不写伪数据；error 进状态 |

GraphQL error path 可用于调试或未来字段级诊断，但默认读取语义不应变成“某字段 throw”。字段 getter 返回数据值；请求错误属于 session 状态。

## 无 Identity 对象

不是所有 object 都应该 normalized。

有稳定 identity 的对象进入 entity graph：

```txt
User:1.name
```

无 identity 的 schema object 是 Value Object。它不进入全局 entity graph，只在所属 root/entity/value path 下拥有 embedded address：

```txt
User:1.status.online
User:1.status.source.kind
```

Value Object 可以递归拆到 leaf field signal，但不能拥有独立 ref，不能参与 `.ids` / `.refs`，也不生成 entity invalidation spec。自定义 JSON scalar 仍作为单个 leaf field value，不按运行时对象结构递归拆分。

若应用需要把某个类型当实体，必须在 schema 中暴露非空 scalar `id` 字段。GQLens 不通过 codegen option 或 schema directive 配置非 `id` identity key。

## Incremental Delivery

`@defer` / `@stream` 不应改变 accessor shape。它们改变的是 payload 到达时间：

```txt
initial payload → normalize → field signals
incremental payload → normalize → same field signals
```

因此它属于 Planner / Transport / GraphDataStore 的协作能力。未来可以在 prepared selection 上提供调度选项，但不应在字段 getter 后挂载临时 API。

## Subscription 与 Live

GraphQL subscription 可以实现 `LiveSubscriber`，但 GQLens 的 live transport 不绑定 GraphQL subscription 协议。

```txt
GraphQL subscription / SSE / WebSocket / business channel
  → LiveSubscriber
  → GraphDataStore
  → field signal
```

所有 query 都是 reactive；只有持续传输才是 live。

## 不映射为 Accessor 的能力

以下能力不应进入字段链：

- alias 命名
- arbitrary directive chaining
- dynamic field name
- fragment string / GraphQL document string
- field-level fetch policy
- field-level transport selection

这些能力会让 accessor graph 从 schema-generated contract 退化成动态 query builder。GQLens 应把它们放在 Planner、prepared selection、session policy 或 transport adapter 中。

允许的字段链形态见 [API 语法规范](./规范-API语法.md)。

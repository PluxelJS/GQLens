# API 语法规范

本章是 GQLens accessor API 的最小语法表。它用于约束 codegen、lint、文档和 LLM 推理：没有出现在这里的字段链形态，默认不应设计。

## Runtime 入口

入口名遵守宿主 runtime 约定：

| Runtime           | Query API              | Live API              |
| ----------------- | ---------------------- | --------------------- |
| React             | `useQuery()`           | `useLiveQuery()`      |
| Solid             | `createQuery()`        | `createLiveQuery()`   |
| framework-neutral | `createQuery()`        | `createLiveQuery()`   |
| selector builder  | `defineSelection()`    | 不负责 live transport |
| invalidation      | `defineInvalidation()` | 不负责 live transport |

不得设计裸 `query()` 作为公共入口。它语义过宽，容易被理解为立即执行一次 transport。

入口之后的 accessor graph 必须一致：

```ts
const q = useQuery();
q.user({ id }).name;
```

## 字段访问 Grammar

```txt
RootAccessor       ::= q
RuntimeQuery       ::= useQuery() | useLiveQuery() | createQuery() | createLiveQuery()

FieldAccess        ::= GetterField | ArgsField
GetterField        ::= Accessor "." fieldName
ArgsField          ::= Accessor "." fieldName "(" PlainArgs? ")"

ScalarRead         ::= EntityAccessor "." scalarField
EntityRelation     ::= EntityAccessor "." entityField
EntityList         ::= Accessor "." listField "(" PlainArgs? ")" ".ids"
AbstractList       ::= Accessor "." abstractListField "(" PlainArgs? ")" ".refs"
InlineFragment     ::= AbstractAccessor ".$on." TypeCondition "." FieldAccess

PreparedSelection  ::= defineSelection("(" "(q, v) => FieldAccess*" ")")
Invalidation       ::= defineInvalidation("(" "(q) => FieldAccess" ")")
```

示例：

```ts
q.viewer.name;
q.user({ id }).avatar;
q.post({ id }).author.name;
q.todos({ done: false }).ids;
q.search({ text }).refs;
q.pet({ id }).$on.Cat.meows;
```

## 读取终点

只有两类读取终点：

| 终点          | 示例                         | 语义                           |
| ------------- | ---------------------------- | ------------------------------ |
| scalar field  | `q.user({ id }).name`        | demand + field signal read     |
| list identity | `q.todos(args).ids` / `refs` | demand + slot/list signal read |

entity relation 只推进 path：

```ts
q.post({ id }).author; // accessor，不是 Author 数据对象
```

`q.user({ id })` 返回 accessor node，不返回 `User` 数据对象，不订阅整个 `User:<id>`。

## List 形态

普通 entity list：

```ts
q.todos({ done: false }).ids;
```

abstract list：

```ts
q.search({ text }).refs;
```

`ids` 只适合元素类型唯一的 entity list。interface / union list 必须使用 `refs`，因为不同 concrete type 可能共享同一个 `id`，需要 `type + id` 才能形成稳定 entity ref。

列表只表达成员、顺序、分页窗口。行字段必须重新进入 root / entity accessor：

```ts
for (const id of q.todos({ done: false }).ids ?? []) {
  q.todo({ id }).title;
}
```

## Abstract Type

common field 直接访问：

```ts
q.pet({ id }).name;
q.pet({ id }).__typename;
```

type condition 通过 `$on`：

```ts
q.pet({ id }).$on.Cat.meows;
```

`$on.<TypeCondition>` 等价于 GraphQL `... on <TypeCondition>`。可选分支由 schema metadata 生成，不由运行时属性探测决定。

分支不适用时返回 `undefined`，不是 `null`。

## Args

args 必须是 canonical GraphQL input value：

```ts
q.user({ id }).name;
q.todos({ filter: { done: false }, first: 20 }).ids;
```

允许：

- scalar
- enum value
- `null`
- array
- plain object
- prepared selection variable placeholder：`v("id")`

不允许：

- function
- class instance
- `Date`
- `Map` / `Set`
- accessor node
- dynamic field path

args 是 selection key 的一部分，必须按 canonical JSON 语义比较。

## Prepared Selection

prepared selection 复用同一套 accessor graph：

```ts
const userCard = defineSelection((q, v) => {
  q.user({ id: v("id") }).name;
  q.user({ id: v("id") }).avatar;
});
```

它只收集 selection path，不读 signal，不订阅 reader，不调度 transport。它用于提前 fetch、SSR、persisted hash、稳定 operation name 和静态诊断。

selector callback 必须是纯 path collector：

```ts
defineSelection((q, v) => {
  q.user({ id: v("id") }).name;
});
```

不要在 selector 内放控制流、异步、副作用或嵌套函数。

## Invalidation

invalidation 使用单独 builder：

```ts
defineInvalidation((q) => q.todos({ done: false }).ids);
defineInvalidation((q) => q.user({ id }).name);
```

它只收集 affected path / slot，不读取 cache signal，不改变 active selection。

## 禁止形态

这些 API 不应设计：

```ts
query();
q.field("user", args).field("name");
q.select("Query.user.name");
q.read(path);

q.todos({ done: false }).map((todo) => todo.title);
q.todos({ done: false })[0];
q.todos({ done: false }).item(id);
q.todos({ done: false }).node(id);

q.user({ id }).name.$include(cond);
q.user({ id }).name.$skip(cond);
q.user({ id }).as("Cat").meows;
q.user({ id }).fragment("Cat").meows;

q.invalidate((x) => x.todos({ done: false }).ids);
{ ...q.viewer };
Object.keys(q.viewer);
JSON.stringify(q.viewer);
```

原因：

- dynamic field API 绕过 schema-generated contract
- list array API 混淆 list identity 与 entity field
- field-level directive API 把 operation metadata 塞回字段链
- runtime `q.invalidate()` 混淆 read context 与 invalidation selector context
- object operations 把 accessor node 误当数据对象

## LLM 决策规则

当需要表达 GraphQL 功能时，按顺序选择落点：

1. 字段是否存在于 schema：由 codegen accessor 表达。
2. 是否只是字段路径 / args：放入 accessor graph。
3. 是否是类型分支：用 `$on.<TypeCondition>`。
4. 是否是 list identity：普通列表用 `ids`，abstract list 用 `refs`。
5. 是否是 operation 序列化细节：放入 Planner。
6. 是否是预取 / SSR / persisted query：用 `defineSelection()`。
7. 是否是 cache 影响范围：用 `defineInvalidation()`。
8. 是否是协议和持续传输：放入 Transport / `LiveSubscriber`。
9. 如果需要动态字段名、字符串 query、字段级策略链，默认拒绝进入 accessor API。

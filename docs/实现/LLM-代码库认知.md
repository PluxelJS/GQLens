# LLM 代码库认知

本文给零上下文 LLM / coding agent 使用。目标是在改代码前快速建立 GQLens 的实现地图和不可破坏的语义。

先读本文件建立代码地图；如果需要判断“当前是否已经接入 runtime”，再读 [实现状态](./实现状态.md)。

## 项目目标

GQLens 是一个 schema-generated accessor graph + GraphDataStore 的 GraphQL reactive runtime。

用户不写 query string，也不写动态 field API。用户读取生成的 accessor：

```ts
const q = useQuery();
q.user({ id }).name;
q.todos({ done: false }).ids;
q.search({ text }).refs;
q.pet({ id }).$on.Cat.meows;
```

读取动作会记录 selection path，并从 GraphDataStore 读 signal。session 根据 active selection 规划 GraphQL operation、fetch、normalize、更新 signal。

## Workspace 地图

```txt
packages/core
  src/cache.ts          GraphDataStore
  src/planner.ts        selection paths -> GraphQL operation
  src/session.ts        active demand + fetch/live scheduling
  src/invalidation.ts   invalidation helper
  src/mutation.ts       shared mutation runner
  src/keys.ts           canonical path/slot keys
  src/collector.ts      per-reader selection collection
  src/transport.ts      default HTTP/live transport helpers
  codegen/index.ts      generated accessor runtime

packages/codegen
  src/accessor.ts       typed accessor/hooks/schema contract/mutation descriptor generator
  src/invalidation.ts   invalidation type generator
  src/generate.ts       generateFiles entry

packages/vite
  src/entry.ts          defineGQLensEntry typed Vite entry helper
  src/plugin.ts         Vite codegen/HMR/middleware plugin
  src/write-generated-files.ts content-diff generated file writer

packages/react
  src/index.tsx         Provider, useQuery/useLiveQuery, useMutation

packages/solid
  src/index.ts          createQuery/createLiveQuery, createMutation

packages/oxlint-plugin
  src/index.ts          selector/accessor usage lint rules
```

## 核心数据结构

`SelectionPath`：

```ts
{
  root: "Query",
  steps: [
    { field: "user", args: { id: "1" } },
    { field: "name" },
  ],
}
```

`SelectionStep`：

- `field`: GraphQL field name, list identity pseudo-field, or `$on`
- `args`: canonical GraphQL input object
- `typeCondition`: inline fragment type condition for `$on`

`EntityRef`：

```ts
{ type: "User", id: "1" }
```

`GraphDataInvalidation`：

- address target: `{ kind: "address", address, family? }`
- entity target: `{ kind: "entity", ref, paths? }`
- root target: `{ kind: "root", root, paths? }`
- selection target: `{ kind: "selection", path, schema? }`

## GraphDataStore 语义

GraphDataStore 在 `packages/core/src/cache.ts`。

当前 `cache.ts` 的 normalize 会优先使用 schema contract；缺少 schema contract 时才退回到 `__typename + id` 的通用识别。Entity / Value Object 规则见 [服务端 Schema 设计指南](../服务端-Schema设计指南.md)。

实体字段：

```txt
User:1.name
User:1.__typename
```

root / relation / list slot：

```txt
Query.user({"id":"1"})            -> EntityRef | null
Query.todos({"done":false}).ids   -> readonly string[]
Query.search({"text":"x"}).refs   -> readonly EntityRef[]
User:1.posts({"first":10}).ids    -> readonly string[]
```

规则：

- schema object 有非空 scalar `id` 才进入 entity graph。
- schema object 没有 `id` 时是 Value Object，以父 owner 为根递归拆到 embedded leaf signal。
- 自定义 JSON scalar 和 scalar / enum list 仍作为单个 leaf field value，不按运行时对象结构递归拆分。
- entity array 同时会写 relation slot、`.ids` 和 `.refs`；typed accessor 决定暴露哪一个。
- `undefined` 表示 missing，`null` 表示服务端 null。
- stale entry 保留旧值，只改 `expires`。

## Accessor Runtime

位置：`packages/core/codegen/index.ts`

`createAccessorNode()` 生成非枚举 accessor 对象。

行为：

- scalar getter：`ctx.demand(steps)`，然后读 store signal。
- entity relation：返回新的 accessor node，不读取整个对象。
- concrete entity root 有 `id` arg 时，可用 `Type:id` 快捷定位。
- abstract entity root 不能用 `Abstract:id` 快捷定位，必须等 slot 里有真实 `EntityRef`。
- list accessor：concrete list 暴露 `.ids`；abstract list 暴露 `.refs`。
- `$on` accessor：由 schema contract 生成分支；分支不匹配返回 `undefined`。
- `defineSelection()` 只收集 paths 和 variable placeholder。
- `defineInvalidation()` 返回 `GraphDataInvalidation`。

不要让 accessor node 可枚举。`Object.keys(q.viewer)` / `JSON.stringify(q.viewer)` 应保持空对象语义。

## Planner

位置：`packages/core/src/planner.ts`

输入：`SelectionPath[]`

输出：`GraphQLOperation`

职责：

- 合并相同 root/args 的选择。
- 同名不同 args 自动 alias。
- args 提取成 variables。
- prepared variable placeholder `v("id")` 渲染为 `$id`，不写入 `variables` 值。
- entity selection 自动补 `id` 和 `__typename`。
- `.ids` / `.refs` 是 accessor pseudo-field，不渲染到 GraphQL。
- abstract `.refs` 会渲染 `__typename` 和各 possible concrete type 的 `id` fragment。
- `$on.<TypeCondition>` 渲染为 `... on TypeCondition { ... }`。

`operation.selections` 会保留 response alias，供 session 把响应同步回原始 slot key。

## Session

位置：`packages/core/src/session.ts`

`createQuerySession({ store, fetcher, ...query })`：

- 收集 active selection。
- 根据 policy 判断 freshness。
- 调 `plan()`。
- 调 fetcher。
- `store.writeGraphQLResult(result, { ttl, schema })`。
- `syncSlots()` 把 root/relation/list identity slot 写回原始 selection key。

`createLiveQuerySession({ store, subscriber, ...query })`：

- 同样使用 active selection + planner。
- 用 subscriber 替代一次性 fetch。
- live patch 仍写入同一个 GraphDataStore。

Cache policy：

- `cache-first`: fresh 时不 fetch。
- `cache-and-network`: 返回缓存，同时后台 fetch；同一 fresh completed operation 不重复。
- `network-only`: 总走网络，但仍 normalize 到 store。

## Invalidation

位置：`packages/core/src/invalidation.ts`

`applyInvalidations(store, invalidations, schema?)` 支持：

- `GraphDataInvalidation` target：`address` / `entity` / `root` / `selection`
- `entity` target：失效整个 entity 或指定 `paths`
- `selection` target：失效对应 root slot family；如果 schema contract 能定位 concrete root entity，也会失效 owner entity address family

React/Solid mutation options 的 `invalidates` 接受 `GraphDataInvalidation[]`。mutation runner 会应用 invalidation；React provider 传入额外策略，在成功后 refetch active sessions。

## Mutation Runner

位置：`packages/core/src/mutation.ts`

`createMutationRunner({ store, definition, fetcher, invalidate? })` 是 React/Solid 共享的 mutation 流程。

职责：

- 支持 operation descriptor 和 callback mutation。
- operation descriptor 通过 fetcher 执行，并支持 GraphQL response envelope。
- optimistic callback 通过 `GraphDataAddress` 读写 store。
- 成功后应用 invalidates，并通过 `writeGraphQLResult()` 写入 server response。
- optimistic 写入在 `store.transaction()` 中执行；失败时 rollback transaction，和 invalidation hints 解耦。

框架适配器不应重新实现 snapshot / rollback / result 写入流程。React 只传入自定义 `invalidate`，用于 invalidation 后 refetch provider 内 active sessions；Solid 默认使用 core invalidation。

## Codegen

位置：`packages/codegen/src/accessor.ts`

`accessor.ts` 由 `code-block-writer` 打印，避免手写字符串拼接生成块级 TypeScript。生成文件按固定 section 排列：

- typed accessor nodes
- schema contract consumed by `@gqlens/core`
- runtime entrypoints
- static selector builders
- mutation operation descriptors

生成内容：

- `QueryNode` 等 typed node interface。
- 每个 node 都有 `readonly __typename: string | undefined`。
- object/interface common field 直接生成 getter/field function。
- list of object -> `{ ids }`
- list of interface/union -> `{ refs }`
- interface/union -> `$on` 分支。
- union 没有 common schema fields，但有 `__typename` 和 `$on`。
- `gqlensSchema` 提供 accessor、planner、normalize、invalidation 共用的 runtime contract。
- `useQuery` / `useLiveQuery` 或 Solid 的 `createQuery` / `createLiveQuery`。
- `defineSelection` / `defineInvalidation` wrapper。
- mutation operation descriptor `api`。

位置：`packages/codegen/src/invalidation.ts`

生成：

- `Invalidation = GraphDataInvalidation`

## Vite Package

位置：`packages/vite/src/plugin.ts`

`@gqlens/vite` 是 codegen 的构建工具适配包，不属于 core/runtime。GraphQL entry 从 `@gqlens/vite/entry` 导入零依赖 helper，并 default export `defineGQLensEntry({ schema, handler? })`：

- `schema()` 返回 SDL 字符串。Vite 包刻意不要求 `GraphQLSchema`，避免 monorepo/link 下多份 `graphql` instance 导致 schema realm 问题。
- dev 阶段用 `server.ssrLoadModule(entry)` 重新加载 entry，文件变化后清空 entry/handler cache。
- build 阶段用 Node native import 读取同一 entry，所以 entry 的运行时 import 必须能被 Node ESM 解析。
- `handleHotUpdate` 只对 `include` 匹配文件和 entry 自身响应；SDL 相同则跳过 codegen。
- 写 generated 文件前做 content-diff。Vite 客户端 HMR 依赖普通文件变更，不手动广播 reload。
- 写 `.gqlens-meta.json` 记录 schema / 生成选项 / 输出文件 hash；启动和 build 时若 metadata 与文件内容都匹配，就跳过完整 codegen。
- `handler(server)` 可选。插件运行时传入原始 Vite dev server；公开类型只描述 entry 需要的 `ssrLoadModule()` 能力，避免 file-link/monorepo 下多个 Vite 类型实例互相比较。存在 handler 时插件在 dev server 上挂 `/graphql` middleware；外部 GraphQL server/proxy 场景可设 `middleware: false`。

不要把 Vite-only 类型、Node fs、schema loading 或 middleware 逻辑放进 `@gqlens/core`。

## 框架适配器

React：

- `GQLensProvider` 持有 shared store、fetcher、session map。
- `useGQLensSession()` 建立 reader scope。
- render 时 `demand()` 写入当前 render 的 paths。
- layout effect 用 `session.replace(reader, paths)` 替换 active selection，并 `schedule()`。
- signal watch 触发 rerender。

Solid：

- `createQuery()` 创建 session 和 reader scope。
- demand 直接 `session.select()` 并 `schedule()`。
- signal watch 用 Solid signal 触发依赖更新。

Mutation：

- 复用 `createMutationRunner()`。
- React provider 给 runner 传入自定义 invalidate，以便成功后 refetch active sessions。
- Solid 使用 runner 默认 invalidation。

## 不要做的事

- 不要新增动态 field API，例如 `q.field("name")`。
- 不要让 list accessor 变成 array、map、item、node。
- 不要在 field getter 后挂 directive/fetch policy 链。
- 不要把 alias 暴露给用户；alias 是 planner 内部细节。
- 不要把 accessor node 当数据对象展开。
- 不要让 abstract root 用 `AbstractType:id` 伪 ref 读取字段。
- 不要绕过 `applyInvalidations()` 自己在适配器里实现另一套 invalidation。

## 修改优先级

改代码时优先保持这些边界：

1. schema-generated accessor shape 是公共 API。
2. runtime discovery 和 prepared selection 使用同一套 accessor graph。
3. GraphDataStore 是唯一数据源。
4. planner 只处理 operation 序列化，不读取 store。
5. session 只处理 active demand 和调度。
6. adapter 只处理宿主响应式生命周期。

## 验证

常用命令：

```bash
npm run test --workspace @gqlens/core
npm run test --workspace @gqlens/codegen
npm run test --workspace @gqlens/react
npm run test --workspace @gqlens/solid
npm run verify
```

最终提交前应跑：

```bash
npm run verify
```

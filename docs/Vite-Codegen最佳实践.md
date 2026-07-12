# Vite Codegen 最佳实践

## 为什么这是一条主线

GQLens 的前端 API 建立在 schema-generated accessor contract 上。应用代码读取的是生成出来的
`api`、`useQuery`、`defineSelection` 和 `defineInvalidation`，不是运行时动态字段探测。

因此，Vite 应用的推荐接入方式不是“手动跑一次 codegen 再启动前端”，而是让
`@gqlens/vite` 成为开发和构建链路的一部分：

- dev server 启动时保证 generated 文件存在；
- GraphQL SDL 变化时才重新生成；
- generated 文件内容变化时才写盘，让普通 Vite HMR 接管前端更新；
- build 开始时校验 generated 文件和 `.gqlens-meta.json`；
- schema/handler 入口保持真实 TypeScript 文件，IDE 和 LLM 都能直接发现。

`examples/yoga-vite-codegen/design.md` 是完整设计记录；这份文档是应用集成者应优先阅读的
入口。

## 推荐目录

```txt
src/
  graphql-entry.ts        # default export defineGQLensEntry(...)
  schema.ts               # 真实 schema/SDL 来源
  yoga.ts                 # 可选：dev middleware handler factory

web/
  client/                 # 前端应用代码
  gqlens/                 # generated files
```

Pluxel 的组件前端使用同一模式，只是输出目录在应用源码内：

```txt
packages/components/src/app/gqlens/
  graphql-entry.ts
  accessor.ts             # generated
  invalidation.ts         # generated
  types.ts                # generated
  .gqlens-meta.json       # generated metadata
```

## Vite 配置

Vite 应用优先使用 `@gqlens/vite`：

```ts
import { gqlens } from "@gqlens/vite";

export default defineConfig({
  plugins: [
    gqlens({
      output: "web/gqlens",
      entry: "/src/graphql-entry.ts",
      endpoint: "/graphql",
      include: [/src\/schema\.ts$/, /src\/graphql-entry\.ts$/],
      framework: "react",
      middleware: true,
    }),
  ],
});
```

`entry` 指向真实 TypeScript 文件，不指向 virtual module。entry default export
`defineGQLensEntry({ schema, handler? })`：

```ts
import { defineGQLensEntry } from "@gqlens/vite/entry";
import { createSchemaSDL } from "./schema.ts";

export default defineGQLensEntry({
  schema: () => createSchemaSDL(),
  handler: async (server) => {
    const mod = (await server.ssrLoadModule("/src/yoga.ts")) as typeof import("./yoga.ts");
    return mod.createYogaHandler();
  },
});
```

如果 GraphQL endpoint 由独立后端提供，保留 codegen/HMR 能力，但关闭 Vite middleware：

```ts
gqlens({
  output: "src/app/gqlens",
  entry: "/src/app/gqlens/graphql-entry.ts",
  endpoint: "/graphql",
  include: [/packages\/runtime\/src\/api\//],
  framework: "react",
  middleware: false,
});
```

这就是 Pluxel `packages/components/vite.config.ts` 的模式：前端 generated 文件仍由
`@gqlens/vite` 维护，GraphQL 请求则走 Pluxel runtime。

## GraphQLSchema 与 SDL

构建工具集成里优先让 entry 返回 SDL 字符串：

```ts
export default defineGQLensEntry({
  schema: () => createInternalGraphQLSchemaSDL(context),
});
```

原因是 monorepo/link、Vite SSR runner、Yoga、GQLoom 或 CJS/ESM 混用时，进程里可能出现多份
`graphql` package realm。把 `GraphQLSchema` 对象跨 realm 交给插件处理，容易触发 GraphQL
instance 校验问题。最稳的边界是在 schema 模块内部用同一份 `graphql` 打印 SDL，再把字符串交给
GQLens。

## 什么时候直接用 @gqlens/codegen

普通 Vite 应用不需要直接依赖 `@gqlens/codegen`。优先使用：

- `@gqlens/vite` 插件：dev/build 自动生成；
- `generateGQLensFiles()`：非 Vite 脚本复用同一套写盘和 metadata 逻辑。

只有在下面场景才直接调用 `@gqlens/codegen` 的 `generateFiles()`：

- 你正在写 Rolldown、Rspack 或其他构建工具插件；
- 你只需要纯内存文件映射，写盘、metadata、watch、HMR 都由自己的系统负责。

即使你有产品自己的服务端/source-only dev 分支，需要把当前 runtime schema 直接写成前端文件，也应
优先调用 `@gqlens/vite` 的 `generateGQLensFiles()`。Pluxel runtime 的 `InternalGraphQLService`
就是这个模式：它拿当前 runtime schema 生成 `packages/components/src/app/gqlens/`，但不直接依赖
`@gqlens/codegen`。

## HMR 决策

```txt
GraphQL-related source changed
        ↓
Vite invalidates SSR module graph
        ↓
@gqlens/vite reloads typed entry
        ↓
entry.schema() returns SDL
        ↓
normalize SDL and compare with previous SDL
        ↓
SDL unchanged:
  skip codegen
  skip generated file writes
  client HMR not touched

SDL changed:
  generate files
  content-diff each generated file
  changed files trigger normal Vite HMR
```

resolver、context、loader 或 Yoga 配置变化通常只需要刷新 GraphQL handler；如果 SDL 不变，不应触发
GQLens codegen。

## 生成文件规则

generated 目录由工具维护：

- `types.ts`
- `accessor.ts`
- `invalidation.ts`
- `.gqlens-meta.json`

不要手写这些文件。需要审查 API 形态时，看 schema、`graphql-entry.ts` 和 generated diff；需要调
HMR 行为时，看 `@gqlens/vite` 的日志和 `.gqlens-meta.json` 是否匹配。

## LLM 接入提示

当任务涉及 GQLens Vite/codegen 集成时，优先阅读：

1. `docs/Vite-Codegen最佳实践.md`
2. `examples/yoga-vite-codegen/README.md`
3. `examples/yoga-vite-codegen/design.md`
4. `packages/vite/src/plugin.ts`
5. `packages/vite/src/generate.ts`
6. `packages/codegen/src/generate.ts`

不要只读 `@gqlens/core` 或 React adapter。构建工具适配属于 `@gqlens/vite`，纯生成函数属于
`@gqlens/codegen`，运行时缓存和 selection 属于 `@gqlens/core`。

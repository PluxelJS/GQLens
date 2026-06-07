# Yoga + Vite + GQLens Codegen 示例

这个示例展示应用侧如何把 Yoga、Vite HMR 和 GQLens codegen 串起来。`@gqlens/codegen` 只负责把 schema 生成文件内容；Vite/Rolldown 插件何时调用、如何写盘、如何 watch，都由应用或外部工具决定。

## 核心边界

- 服务端入口都是真实 TS 文件：`src/graphql-entry.ts`、`src/schema.ts`、`src/yoga.ts`、`src/server.ts`。
- 前端代码放在 `web/client`，GQLens 生成物放在 `web/gqlens`。
- dev 下 Vite `ssrLoadModule()` 重新 import `src/graphql-entry.ts`，拿到 typed GraphQL entry，打印 SDL，并用内存里的上一次 SDL 判断类型系统是否变化。
- 只有 SDL 变化时才调用 `generateFiles()`；磁盘 content-diff 只发生在应用侧写 generated TS 文件前。
- Vite dev server 同时承载前端、`/graphql` middleware、schema diff 和 codegen HMR。
- build 下直接 native import 同一个 GraphQL entry 的 default export，并在 `buildStart` 里调用 `generateFiles()`。
- dev 插件只用 Vite `handleHotUpdate`，不维护额外依赖图。

## 关键配置

`vite.config.ts` 只注册一个应用侧 Vite 插件。`src/graphql-entry.ts` default export `defineGraphQLEntry(...)`，声明 schema provider 和可选 handler；dev 下插件通过 Vite 重新加载这个真实 TS entry，build 下通过 Node native import 读取同一个 default export：

```ts
graphqlCodegenPlugin({
  output: "web/gqlens",
  entry: "/src/graphql-entry.ts",
  endpoint: "/graphql",
  include: graphQLRelatedFiles,
  framework: "react",
  middleware: !process.env.GRAPHQL_PROXY_TARGET,
});
```

GraphQL entry 本身是普通 TypeScript 文件，IDE 可以直接推导 schema/handler 签名。`handler` 拿到的是原始 `ViteDevServer`，不需要应用理解插件自造的 context：

```ts
import { defineGraphQLEntry } from "../tooling/graphql-entry.ts";
import { createSchemaSDL } from "./schema.ts";

export default defineGraphQLEntry({
  schema: () => createSchemaSDL(),
  handler: async (server) => {
    const mod = (await server.ssrLoadModule("/src/yoga.ts")) as typeof import("./yoga.ts");
    return mod.createYogaHandler();
  },
});
```

因为 build 阶段会用 Node native import 读取这个 entry，entry 中参与 `schema()` 的运行时 import 需要是 Node ESM 可解析的路径。示例在 `tsconfig.json` 开启 `allowImportingTsExtensions`，并在 entry 里使用 `.ts` 后缀 import。

在 monorepo/link 或 GQLoom 这类 code-first 场景里，最稳的是让 schema 模块自己用同一份 `graphql` 打印 SDL，再由 GraphQL entry 返回字符串：

```ts
import { printSchema } from "graphql";
import { weave } from "@gqloom/core";

export function createSchemaSDL() {
  return printSchema(weave(...));
}
```

插件本身不依赖 LogTape；这个 example 只是通过 `logger` 选项把本地日志注入进去。

dev 插件内部复用公共接口，并在插件层处理写盘；这里的 `writeGeneratedFiles()` 是示例本地 helper，不是 GQLens API：

```ts
const files = await generateFiles({
  schema: sdl,
  framework: "react",
});

await writeGeneratedFiles(files, "web/gqlens");
```

如果你想写自己的 Rolldown/Vite/Rspack 插件，只需要在合适的 hook 里拿到 SDL，然后调用 `@gqlens/codegen` 的 `generateFiles()`。GQLens 不接管 output path、content-diff 写盘、watch/filter/candidate discovery。

`generateFiles()` 也接受 `GraphQLSchema`，但构建工具里可能出现多份 `graphql` 包实例；最稳的方式是在应用侧用同一份 `graphql` 先 `printSchema()`，再把 SDL 字符串交给 GQLens。

## HMR 流程

```txt
src/* changed
  -> Vite invalidates server module graph
  -> plugin imports /src/graphql-entry.ts with ssrLoadModule()
  -> entry.schema()
  -> normalize SDL
  -> compare with last in-memory SDL
  -> SDL changed: generate web/gqlens/*
  -> generated files are written only if content changed
  -> generated content changed: Vite client graph HMR

POST /graphql
  -> same Vite dev server middleware
  -> current Yoga handler
  -> file change clears entry and handler cache
  -> next request imports /src/graphql-entry.ts again
```

Resolver/context-only changes refresh the Yoga handler, but SDL stays identical, so GQLens codegen and client HMR do not run.

## 前后端演示

这个 example 默认由一个 Vite dev server 同时运行前端和 GraphQL middleware：

- Vite 前端：`http://127.0.0.1:5173`
- GraphQL：`http://127.0.0.1:5173/graphql`
- 前端请求相对路径 `/graphql`，由同一个 Vite dev server 处理。

前端页面会通过 generated accessor 读取：

- `q.viewer.name`
- `q.users.ids`
- `q.user({ id })`
- `q.posts.ids`
- `q.post({ id }).comments.ids`

并通过 generated mutation descriptor 调用：

- `api.comment.add`
- `api.userOnline.toggle`

`web/client/generated-usage.ts` 是手写的类型样例，参与 `tsc --noEmit`，用于证明 generated accessor、selector、invalidation 和 mutation descriptor 可以被前端正常消费。

如果需要模拟真实前后端分离，也可以开两个终端运行 `npm run dev:server` 和 `npm run dev:client`。此时前端请求仍然使用相对路径 `/graphql`，由 Vite proxy 转发到独立 Yoga server。

## GQLens DX 证明点

这个示例刻意不用手写 GraphQL operation 字符串驱动页面。前端直接读 schema 生成的 accessor：

```tsx
const q = useQuery();
const postIds = q.posts.ids ?? [];
const post = q.post({ id: postIds[0] ?? "p1" });
```

这样带来的开发体验是：

- 字段名、参数和 mutation input 都来自 schema 生成类型，写错会被 `tsc` 拦住。
- 组件读了哪些字段就是 selection 需求，不需要同步维护 `query { ... }` 字符串。
- `api.comment.add` 这类 mutation descriptor 由 schema 生成，变量序列化和结果类型保持一致。
- `defineInvalidation((q) => q.post({ id }).comments.ids)` 用同一套 accessor 表达 cache 影响范围。

`web/client/generated-usage.ts` 里同时放了正例和 `@ts-expect-error` 反例。`npm run typecheck` 会验证：访问不存在字段、缺少 query 参数、漏传 mutation input、使用不存在的 mutation group 都会失败。

## 日志

这个 example 在应用/tooling 层使用 LogTape，不把 logger 接进 GQLens core/runtime：

- `tooling/generate-gqlens.ts` 记录 codegen 输出目录、文件数、changed/skipped 数量和耗时。
- `tooling/vite-plugin-graphql.ts` 记录 dev HMR 中 SDL unchanged、schema changed、middleware/proxy 状态。
- `src/server.ts` 记录独立 Yoga 服务启动。

默认日志级别是 `info`。如果要看 resolver-only 变更时“SDL 未变化，所以跳过 codegen”的细节：

```sh
GQLENS_EXAMPLE_LOG_LEVEL=debug npm run dev
```

## 生成文件

`web/gqlens/` 只提交 README 和 `.gitignore`。运行 dev/build 后会生成：

- `web/gqlens/types.ts`
- `web/gqlens/accessor.ts`
- `web/gqlens/normalizer.ts`
- `web/gqlens/invalidation.ts`

这些文件来自 schema，不应该手写。

## 运行

先在仓库根目录构建本地包：

```sh
npm run verify
```

再进入本示例目录：

```sh
npm install
npm run verify
```

开发时默认只需要：

```sh
npm run dev
```

如果要模拟前后端分离，开两个终端：

```sh
npm run dev:server
npm run dev:client
```

也可以单独检查生成物和类型：

```sh
npm run codegen
npm run typecheck
npm run test
```

这个示例使用 `graphql` 原生构造器，避免仓库把某个服务端框架 API 写死。如果换成 GQLoom，保持边界不变，只需要把 `createSchema()` 的实现替换成 `weave(...)`。

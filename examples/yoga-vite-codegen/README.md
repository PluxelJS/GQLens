# Elysia + Yoga + Vite + GQLens Codegen 示例

这个示例展示如何把 Elysia、Yoga、Vite HMR 和 GQLens codegen 串起来。应用只需要安装 `@gqlens/vite`；插件会在 Vite dev server 启动和 build 开始时生成前端文件，并负责 schema diff、content-diff 写盘和可选 `/graphql` dev middleware。独立后端用 Elysia 挂载 Yoga，Vite dev 下的 GraphQL HMR 仍然直连同一份 Yoga handler。

## 核心边界

- 服务端入口都是真实 TS 文件：`src/graphql-entry.ts`、`src/schema.ts`、`src/yoga.ts`、`src/http-app.ts`、`src/server.ts`。
- 前端代码放在 `web/client`，GQLens 生成物放在 `web/gqlens`。
- dev 下 Vite `ssrLoadModule()` 重新 import `src/graphql-entry.ts`，拿到 typed GraphQL entry，打印 SDL，并用内存里的上一次 SDL 判断类型系统是否变化。
- 只有 SDL 变化时才调用 `generateFiles()`；磁盘 content-diff 只发生在应用侧写 generated TS 文件前。
- Vite dev server 同时承载前端、`/graphql` middleware、schema diff 和 codegen HMR；独立 Elysia server 只用于前后端分离模式。
- build 下直接 native import 同一个 GraphQL entry 的 default export，并在 `buildStart` 里调用 `generateFiles()`。
- dev/build 不需要前置 `pnpm run codegen`；插件会在前端模块加载前生成 `web/gqlens/*`。
- 生成后会写 `.gqlens-meta.json`；下次启动若 schema、生成选项和输出文件 hash 都匹配，会跳过完整 codegen。
- dev 插件只用 Vite `handleHotUpdate`，不维护额外依赖图。

## 关键配置

`vite.config.ts` 只注册 `@gqlens/vite`。`src/graphql-entry.ts` default export `defineGQLensEntry(...)`，声明 schema provider 和可选 handler；dev 下插件通过 Vite 重新加载这个真实 TS entry，build 下通过 Node native import 读取同一个 default export：

```ts
gqlens({
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

standalone `pnpm run codegen` 只给 `tsc --noEmit`、Node 测试或非 Vite 工具链使用。它从 `@gqlens/vite` 调用同一套生成能力，不要求应用额外安装 `@gqlens/codegen`：

```ts
const writeStats = await generateGQLensFiles({
  schema: sdl,
  framework: "react",
  output: "web/gqlens",
});
```

如果你想写自己的 Rolldown/Rspack 插件，只需要在合适的 hook 里拿到 SDL，然后调用 `@gqlens/codegen` 的 `generateFiles()`。如果只是应用侧使用 Vite，优先复用 `@gqlens/vite`，不需要直接依赖 `@gqlens/codegen`。

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

`src/http-app.ts` 演示常见产品形态：Elysia 作为 HTTP app 外壳，Yoga 只挂在 `/graphql`。这层不参与 GQLens dev HMR；插件仍然通过 `src/graphql-entry.ts -> src/yoga.ts` 直接加载当前 Yoga handler。

`src/yoga.ts` 显式开启 Yoga GraphiQL。浏览器访问 `/graphql`，并带上普通页面请求的 `Accept: text/html` 时，会看到 GraphQL 查询页面；POST JSON 请求仍然进入同一个 endpoint。

## 前后端演示

这个 example 默认由一个 Vite dev server 同时运行前端和 GraphQL middleware：

- Vite 前端：`http://127.0.0.1:5173`
- GraphQL：`http://127.0.0.1:5173/graphql`
- GraphiQL：浏览器打开 `http://127.0.0.1:5173/graphql`
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

前端入口显式创建 `GraphDataStore`，并把浏览器 IndexedDB 里恢复出的 `GraphDataRecords` 注入进去：

```ts
const persisted = await createIndexedDBGraphDataRecords();
const store = createGraphDataStore({ records: persisted.records });

createRoot(root).render(
  <GQLensProvider
    config={{
      fetcher: graphqlFetcher,
      store,
      query: { policy: "cache-and-network", ttl: 60_000 },
    }}
  >
    <Dashboard />
  </GQLensProvider>,
);
```

`GraphDataRecords` 的 `get()` 是同步契约，所以 example 不把 IndexedDB 直接暴露给 store。启动时先把 IDB snapshot 读进内存 `Map`，之后 `set()` / `delete()` / `clear()` 再异步镜像回 IDB。恢复出的记录会被标成 stale：页面可以先显示上次访问留下的缓存，active selection 随后用当前 GraphQL 响应校准。

`web/client/generated-usage.ts` 是手写的类型样例，参与 `tsc --noEmit`，用于证明 generated accessor、selector、invalidation 和 mutation descriptor 可以被前端正常消费。

如果需要模拟真实前后端分离，也可以开两个终端运行 `pnpm run dev:server` 和 `pnpm run dev:client`。此时前端请求仍然使用相对路径 `/graphql`，由 Vite proxy 转发到独立 Elysia server。

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

`web/client/generated-usage.ts` 里同时放了正例和 `@ts-expect-error` 反例。`pnpm run typecheck` 会验证：访问不存在字段、缺少 query 参数、漏传 mutation input、使用不存在的 mutation group 都会失败。

## 日志

这个 example 在应用/tooling 层使用 LogTape，不把 logger 接进 GQLens core/runtime：

- `tooling/generate-gqlens.ts` 记录 codegen 输出目录、文件数、changed/skipped 数量和耗时。
- `@gqlens/vite` 通过 `logger` 选项记录 dev HMR 中 SDL unchanged、schema changed、middleware/proxy 状态。
- `src/server.ts` 记录独立 Elysia 服务和 GraphQL endpoint 启动。

默认日志级别是 `info`。如果要看 resolver-only 变更时“SDL 未变化，所以跳过 codegen”的细节：

```sh
GQLENS_EXAMPLE_LOG_LEVEL=debug pnpm run dev
```

## 生成文件

`web/gqlens/` 只提交 README 和 `.gitignore`。运行 dev/build 后会生成：

- `web/gqlens/types.ts`
- `web/gqlens/accessor.ts`
- `web/gqlens/invalidation.ts`
- `web/gqlens/.gqlens-meta.json`

这些文件来自 schema，不应该手写。

## 运行

先在仓库根目录构建本地包：

```sh
pnpm run verify
```

再进入本示例目录：

```sh
pnpm install
pnpm run verify
```

开发时默认只需要：

```sh
pnpm run dev
```

`pnpm run dev` 和 `pnpm run build` 都由 Vite 插件自动生成 `web/gqlens/*`，不需要先运行 `pnpm run codegen`。

如果要模拟前后端分离，开两个终端：

```sh
pnpm run dev:server
pnpm run dev:client
```

也可以单独检查生成物和类型。这里的 `codegen` 是给 `tsc`/Node 测试这种绕过 Vite 的命令使用：

```sh
pnpm run codegen
pnpm run typecheck
pnpm run test
```

这个示例的 schema 仍使用 `graphql` 原生构造器，HTTP 外壳使用 Elysia。换成 GQLoom 时保持边界不变，只需要把 `createSchema()` 的实现替换成 `weave(...)`；换成 Hono/Fastify/Express 时也只需要替换 `src/http-app.ts`，`src/graphql-entry.ts` 和 Vite/GQLens HMR 路径不变。

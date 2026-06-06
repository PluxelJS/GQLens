# Yoga + Vite + GQLens Codegen 示例

这个示例展示应用侧如何把 Yoga、Vite HMR 和 GQLens codegen 串起来。`@gqlens/codegen` 只负责把 schema 生成文件内容；Vite/Rolldown 插件何时调用、如何写盘、如何 watch，都由应用或外部工具决定。

## 核心边界

- 服务端入口都是真实 TS 文件：`src/schema.ts`、`src/yoga.ts`、`src/server.ts`。
- 前端代码放在 `web/client`，GQLens 生成物放在 `web/gqlens`。
- dev 下 Vite ModuleRunner 重新 import `schema.ts`，打印 SDL，并用内存里的上一次 SDL 判断类型系统是否变化。
- 只有 SDL 变化时才调用 `generateFiles()`；磁盘 content-diff 只发生在应用侧写 generated TS 文件前。
- Yoga dev middleware 只缓存当前 handler 引用，GraphQL 相关文件变化后替换 handler，不重启 Vite server。
- build 下没有 ModuleRunner，所以 `vite.config.ts` 在 `buildStart` 里直接调用 `generateFiles()`。
- dev 插件只用 Vite `handleHotUpdate`，不维护额外依赖图。

## 关键配置

`vite.config.ts` 分成 build codegen 和 dev HMR 两层。

构建态使用一个应用侧 build 插件，直接调用 codegen 函数：

```ts
const gqlensBuildCodegenPlugin = {
  name: "gqlens-build-codegen",
  apply: "build",
  async buildStart() {
    const files = await generateFiles({
      schema: printSchema(createSchema()),
      framework: "react",
    });
    await writeGeneratedFiles(files, "web/gqlens");
  },
};
```

开发态使用应用侧 Vite 插件，因为 ModuleRunner、middleware 和 proxy 是 Vite dev server 能力：

```ts
graphqlCodegenPlugin({
  output: "web/gqlens",
  schemaEntry: "/src/schema.ts",
  handlerEntry: "/src/yoga.ts",
  endpoint: "/graphql",
  include: graphQLRelatedFiles,
  framework: "react",
  middleware: !process.env.GRAPHQL_PROXY_TARGET,
});
```

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
  -> plugin imports /src/schema.ts with ModuleRunner
  -> createSchema()
  -> printSchema()
  -> compare with last in-memory SDL
  -> SDL changed: generate web/gqlens/*
  -> generated files are written only if content changed
  -> generated content changed: Vite client graph HMR

POST /graphql
  -> same Vite dev server middleware
  -> current Yoga handler
  -> file change clears handler cache
  -> next request creates a fresh handler from /src/yoga.ts
```

Resolver/context-only changes still refresh the Yoga handler, but SDL stays identical, so GQLens codegen and client HMR do not run.

## 前后端演示

这个 example 默认按前后端分离运行：

- Yoga 后端：`http://127.0.0.1:4000/graphql`
- Vite 前端：`http://127.0.0.1:5173`
- 前端请求相对路径 `/graphql`，由 Vite proxy 转发到 Yoga。

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

如果你确实想把 `/graphql` 挂在同一个 Vite dev server 上，可以去掉 `GRAPHQL_PROXY_TARGET`。不过 GraphQL 工具链对多份 `graphql` package instance 很敏感；前后端分离的 proxy 模式更接近真实应用，也更稳定。

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

开发时开两个终端：

```sh
npm run dev:server
```

```sh
npm run dev
```

也可以单独检查生成物和类型：

```sh
npm run codegen
npm run typecheck
npm run test
```

这个示例使用 `graphql` 原生构造器，避免仓库把某个服务端框架 API 写死。如果换成 GQLoom，保持边界不变，只需要把 `createSchema()` 的实现替换成 `weave(...)`。

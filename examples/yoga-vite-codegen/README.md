# Yoga + Vite + GQLens Codegen 示例

这个示例展示应用侧如何把 Yoga、Vite HMR 和 GQLens codegen 串起来。`@gqlens/codegen` 只负责把 schema 生成文件内容；Vite/Rolldown 插件何时调用、如何写盘、如何 watch，都由应用或外部工具决定。

## 核心边界

- 用户入口都是真实 TS 文件：`src/graphql/schema.ts`、`src/graphql/yoga.ts`、`src/gqlens/*`。
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
    await writeGeneratedFiles(files, "src/gqlens");
  },
};
```

开发态使用应用侧 Vite 插件，因为 ModuleRunner、middleware 和 proxy 是 Vite dev server 能力：

```ts
graphqlCodegenPlugin({
  output: "src/gqlens",
  schemaEntry: "/src/graphql/schema.ts",
  handlerEntry: "/src/graphql/yoga.ts",
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

await writeGeneratedFiles(files, "src/gqlens");
```

如果你想写自己的 Rolldown/Vite/Rspack 插件，只需要在合适的 hook 里拿到 SDL，然后调用 `@gqlens/codegen` 的 `generateFiles()`。GQLens 不接管 output path、content-diff 写盘、watch/filter/candidate discovery。

`generateFiles()` 也接受 `GraphQLSchema`，但构建工具里可能出现多份 `graphql` 包实例；最稳的方式是在应用侧用同一份 `graphql` 先 `printSchema()`，再把 SDL 字符串交给 GQLens。

## HMR 流程

```txt
src/graphql/* changed
  -> Vite invalidates server module graph
  -> plugin imports /src/graphql/schema.ts with ModuleRunner
  -> createSchema()
  -> printSchema()
  -> compare with last in-memory SDL
  -> SDL changed: generate src/gqlens/*
  -> generated files are written only if content changed
  -> generated content changed: Vite client graph HMR

POST /graphql
  -> same Vite dev server middleware
  -> current Yoga handler
  -> file change clears handler cache
  -> next request creates a fresh handler from /src/graphql/yoga.ts
```

Resolver/context-only changes still refresh the Yoga handler, but SDL stays identical, so GQLens codegen and client HMR do not run.

## Vite Proxy

默认 dev 模式会在同一个 Vite server 上挂载 `/graphql`。如果已经有独立后端：

```sh
GRAPHQL_PROXY_TARGET=http://localhost:4000 npm run dev
```

此时插件仍然生成 `src/gqlens/*`，但不会注册本地 middleware；客户端继续请求相对路径 `/graphql`，由 Vite proxy 转发。

## 生成文件

`src/gqlens/` 只提交 README 和 `.gitignore`。运行 dev/build 后会生成：

- `src/gqlens/types.ts`
- `src/gqlens/accessor.ts`
- `src/gqlens/normalizer.ts`
- `src/gqlens/invalidation.ts`

这些文件来自 schema，不应该手写。

## 运行

先在仓库根目录构建本地包：

```sh
npm run verify
```

再进入本示例目录：

```sh
npm install
npm run typecheck
npm run dev
```

这个示例使用 `graphql` 原生构造器，避免仓库把某个服务端框架 API 写死。如果换成 GQLoom，保持边界不变，只需要把 `createSchema()` 的实现替换成 `weave(...)`。

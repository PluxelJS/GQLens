# Yoga + Vite + GQLens Codegen 示例

这个示例故意放在 `packages/` 外面，展示应用侧应该怎样把服务端开发、schema codegen 和客户端网络连接起来。

核心原则：

- Vite dev 插件负责 `/graphql` middleware、ModuleRunner import 和 HMR 失效。
- GraphQL 服务端导出 `createSchema()`，不要在开发态持有不可失效的全局 schema 单例。
- `@gqlens/codegen/rolldown` 在构建启动时生成 `src/gqlens/*`，保证客户端 import generated accessor 前文件已经存在。
- `tooling/vite-plugin-gqlens-codegen.ts` 在 dev 下复用同一个 codegen 能力，GraphQL 相关文件变更时重新生成 `src/gqlens/*`。
- 客户端自己提供 `fetcher`，GQLens 只接收传输函数，不拥有 HTTP/auth/retry/SSE/WS 策略。

## 关键配置

`vite.config.ts` 里有两条 codegen 路径。

构建态使用 `@gqlens/codegen/rolldown`：

```ts
const graphQLRelatedFiles = [
  /\/src\/graphql\//,
  /\/src\/services\//,
  /\/src\/server-runtime\//,
] as const;

const gqlensBuildCodegenPlugin = {
  ...gqlensRolldown({
    output: "src/gqlens",
    schema: () => printSchema(createSchema()),
    framework: "react",
    watch: graphQLRelatedFiles,
  }),
  apply: "build",
};
```

开发态使用 Vite 的 ModuleRunner，因为 dev HMR 是 Vite server 层能力，不应该塞进纯 Rolldown 插件：

```ts
gqlensCodegenDevPlugin({
  output: "src/gqlens",
  entry: "/src/graphql/codegen-entry.ts",
  include: graphQLRelatedFiles,
  framework: "react",
});
```

`src/graphql/codegen-entry.ts` 只做一件事：从服务端 `createSchema()` 打印 SDL。

```ts
export function createSchemaSDL(): string {
  return printSchema(createSchema());
}
```

这样服务端执行和客户端生成物共享同一个 schema 来源，但两个插件互不接管对方职责。

## HMR 流程

```txt
修改 src/graphql/schema.ts
  -> vite-plugin-gqlens-codegen.handleHotUpdate()
  -> Vite ModuleRunner import('/src/graphql/codegen-entry.ts')
  -> createSchemaSDL()
  -> GQLens codegen 写入 src/gqlens/*
  -> 客户端 import ../gqlens/accessor 的模块看到新的 generated 文件

POST /graphql
  -> vite-plugin-gql-yoga middleware
  -> 若 handler 缓存为空，ModuleRunner import('/src/graphql/dev-entry.ts')
  -> createYogaHandler()
  -> createSchema()
  -> Yoga 执行 GraphQL operation
```

dev codegen 插件内部会串行化连续的重新生成请求，避免多文件 HMR 时并发写同一组 generated files。

## 客户端网络

客户端没有使用 GQLens 默认 endpoint，而是把应用自己的 fetcher 注入进去：

```tsx
<GQLensProvider config={{ fetcher: graphqlFetcher }}>
  <ViewerName />
</GQLensProvider>
```

`src/client/graphql-fetcher.ts` 是普通应用代码。你可以在这里加入：

- auth header
- retry
- batching
- persisted query
- edge runtime fetch
- SSE / WebSocket / 自定义 RPC 的桥接

GQLens 只消费 `Fetcher`，负责 selection、cache、generated accessor 和字段级读取。

## Vite Proxy

默认运行时，示例使用 `vite-plugin-gql-yoga` 在同一个 Vite dev server 里挂载 `/graphql`。

如果你已经有独立 GraphQL 后端，可以用 Vite proxy 接管 `/graphql`：

```sh
GRAPHQL_PROXY_TARGET=http://localhost:4000 npm run dev
```

此时 `vite.config.ts` 会跳过本地 Yoga middleware：

```ts
...(graphQLProxyTarget ? [] : [gqlYogaDevPlugin(...)])
```

并启用 Vite proxy：

```ts
server: {
  proxy: {
    "/graphql": {
      target: graphQLProxyTarget,
      changeOrigin: true,
    },
  },
}
```

客户端的 `graphqlFetcher` 不需要变化，它仍然请求相对路径 `/graphql`。是否同进程 Yoga、独立后端、反向代理、带鉴权 headers，都是应用自己的网络层选择。

## 生成文件

`src/gqlens/` 只提交 README 和 `.gitignore`。运行 Vite 后会生成：

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

这个示例使用 `graphql` 原生构造器，避免仓库把某个服务端框架 API 写死。如果换成 GQLoom，保持边界不变，只需要把 `createSchema()` 的实现替换成 `weave(userResolver, projectResolver, ...)`。

## Rolldown 插件用法是否最优

这里的用法刻意分成两层：

- 构建态：直接使用 `@gqlens/codegen/rolldown`，它使用 Rolldown hook filter 限定候选模块，并在 `buildStart` 生成文件，避免客户端 import generated accessor 时文件尚不存在。
- 开发态：使用 Vite 插件包装同一个 codegen 能力，因为 `handleHotUpdate`、ModuleRunner、dev server websocket、proxy 都是 Vite 层能力，不属于纯 Rolldown 插件。

也就是说，Rolldown 插件只负责它最擅长的构建期发现、watch 和生成；Vite 插件只负责 dev server/HMR/proxy。两边没有互相冒充。

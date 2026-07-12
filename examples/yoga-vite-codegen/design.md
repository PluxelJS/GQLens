# Vite-native GQLens Codegen HMR 设计

## 目标

这个示例展示 `yoga + gqlens + vite` 的开发期协作方式：

- Vite dev server 同时承载前端和 `/graphql` middleware。
- Vite dev server 的 `ssrLoadModule()` 负责重新加载 server/schema 入口。
- GraphQL handler 在 `src/*` 变化后热替换，不重启 dev server。
- 只有 GraphQL 类型系统实际变化时，才触发 GQLens codegen。
- 只有 generated 文件内容实际变化时，才触发前端 HMR。
- 重启 Vite 时用 generated metadata 校验 schema / 选项 / 文件 hash，命中则跳过完整 codegen。
- 用户代码只使用真实 TS 文件，保证 TypeScript / IDE / 跳转 / 类型提示稳定。

## 目录边界

示例保持前后端清晰分区，不额外拆出 `graphql/ services/ server-runtime/` 这类示例里用不到的层级：

```txt
src/
  graphql-entry.ts         # typed plugin entry，schema/handler 合约
  schema.ts                # schema module，真实 TS
  yoga.ts                  # Yoga handler factory，真实 TS
  context.ts               # context，真实 TS
  server.ts                # optional standalone backend

web/
  client/                  # React app
  gqlens/                  # GQLens generated files

tooling/
  generate-gqlens.ts       # standalone codegen script for tsc/tests
```

前端只 import generated 入口：

```ts
import { useQuery, api } from "../gqlens/accessor";
```

服务端只 import 真实 schema/Yoga 入口：

```ts
import { createSchema } from "./schema";
```

Vite 插件通过 typed GraphQL entry 连接两者：

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

`virtual:` 模块只允许作为工具内部胶水，不作为用户 API。

## 主链路

```txt
src/* changed
        ↓
Vite invalidates SSR module graph
        ↓
插件重新加载 /src/graphql-entry.ts
        ↓
entry.schema()
        ↓
normalize SDL
        ↓
compare with last in-memory SDL
        ↓
如果 SDL 内容变化：
    run GQLens codegen
    content-diff generated TS files
    write .gqlens-meta.json
    changed files trigger normal Vite client HMR
否则：
    skip codegen
    client 不动

POST /graphql
        ↓
Vite middleware
        ↓
current Yoga handler
        ↓
src/* change clears handler cache
        ↓
next request imports /src/graphql-entry.ts again

vite build
        ↓
native import /src/graphql-entry.ts default export
        ↓
entry.schema()
        ↓
check .gqlens-meta.json
        ↓
if stale/missing: run GQLens codegen
        ↓
content-diff generated TS files
```

## GraphQL package realm

GraphQL 会拒绝从另一个 package instance 或 ESM/CJS realm 创建的 `GraphQLSchema`。在 monorepo/link 场景下，Vite SSR runner 和 Yoga 可能分别碰到 `graphql` 的 ESM/CJS 入口。

为保证 middleware 模式可靠，`src/schema.ts` 使用 Node `createRequire()` 加载 `graphql` 的 CJS 入口，让 schema 构造侧和 Yoga 执行侧共享同一份 GraphQL instance。`createSchemaSDL()` 也在 schema 模块内部打印 SDL，避免把 `GraphQLSchema` 对象交给另一份 `graphql` 去 `printSchema()`。

前后端分离模式仍然可用：`npm run dev:server` 启动独立 Yoga server，`npm run dev:client` 通过 Vite proxy 转发 `/graphql`。

## 外部复用

外部项目也通过 typed entry 接入，Vite config 只需要传入口路径：

```ts
import { gqlens } from "@gqlens/vite";

gqlens({
  output: "web/gqlens",
  entry: "/src/graphql-entry.ts",
});
```

dev 阶段用 Vite `ssrLoadModule()` import 这个 entry，让 module graph 负责热更新；build 阶段用 Node native import 读取同一个 default export。插件不猜测 schema/handler 导出名，也不接受另一套 loader API。

因为 build 阶段不经过 Vite transform，typed entry 中参与 `schema()` 的运行时 import 必须能被 Node ESM 解析。示例通过 `.ts` 后缀 import 和 `allowImportingTsExtensions` 保证这一点。

对 GQLoom 或其他 code-first schema，typed entry 返回 SDL 字符串即可，确保 `printSchema()` 和 schema 构造使用同一个 GraphQL instance：

```ts
import { printSchema } from "graphql";
import { weave } from "@gqloom/core";
import { defineGQLensEntry } from "@gqlens/vite/entry";

export default defineGQLensEntry({
  schema: () => printSchema(weave(...)),
  handler: async (server) => {
    const mod = (await server.ssrLoadModule("/src/yoga.ts")) as typeof import("./src/yoga.ts");
    return mod.createYogaHandler();
  },
});
```

插件本身只接受一个可选 logger 接口，不依赖 LogTape 或 example 应用代码；外部工具可以注入自己的日志实现，也可以完全不传。

## Vite 插件职责

插件只做有限职责：

1. 监听 GraphQL 相关真实模块的变更。
2. 通过 Vite SSR module graph 重新加载 typed GraphQL entry。
3. 将 schema source 规范化为 SDL。
4. 对 SDL 做内存 diff。
5. 在 SDL 变化时触发 GQLens codegen。
6. 对 generated TS 文件做 content-diff 写入。
7. 在 dev middleware 中懒加载并缓存 Yoga handler，相关文件变更后清空缓存。
8. 在 buildStart 中 native import typed GraphQL entry 并生成一次文件。

不做：

- 不维护完整独立依赖图。
- 不手动广播前端 reload。
- 不让 GQLens 轮询 endpoint。
- 不把用户类型入口设计成 virtual module。
- 不强行拆分 schema 与 resolver。
- 不为 SDL 强制维护 `.cache` 目录。

## 变更影响矩阵

| 变更类型                          | Yoga handler | SDL artifact | GQLens codegen |       Client HMR |
| --------------------------------- | -----------: | -----------: | -------------: | ---------------: |
| resolver 实现变化                 |         更新 |         不变 |         不触发 |           不触发 |
| query / mutation / field 类型变化 |         更新 |         变化 |           触发 | 按 importers HMR |
| input / enum / scalar 变化        |         更新 |         变化 |           触发 | 按 importers HMR |
| context / dataloader 变化         |         更新 |         不变 |         不触发 |           不触发 |
| Yoga plugin 配置变化              |         更新 |     通常不变 |     通常不触发 |           不触发 |
| generated 文件内容不变            |       不影响 |       不影响 |         不写入 |           不触发 |

## 复用边界

构建工具适配不属于 `@gqlens/core`：core 是 runtime/browser-facing 包，不引入 Node fs、GraphQL schema loading 或构建 hook。`@gqlens/codegen` 不内置构建工具 hook 或写盘策略；它只提供外部插件可调用的纯生成函数。Vite 适配单独放在 `@gqlens/vite`，既能复用 codegen，又不会把 Vite/Node fs 概念放进 core/runtime：

- `generateFiles()` 接受 SDL 或 `GraphQLSchema`，返回 generated 文件内容映射。构建插件里优先传 SDL 字符串，因为 monorepo/link 场景可能存在多份 `graphql` 包实例。
- `@gqlens/vite` 负责 output path、content-diff 写盘、watch/filter/schema loading/HMR/middleware/proxy，并在合适的 hook 中调用上述函数；应用侧若要给 `tsc`/Node 测试预生成，也从 `@gqlens/vite` 调用同一套 `generateGQLensFiles()`。
- `.gqlens-meta.json` 只用于启动/build 快速判断生成物是否仍然有效；缺失、版本不匹配、schema hash 不匹配、选项 hash 不匹配或文件 hash 不匹配时都会重新生成。
- 外部 Rolldown/Rspack 插件可以复用同一条 `generateFiles()` 边界。

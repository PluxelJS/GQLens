# Vite-native GraphQL HMR 设计

## 目标

基于 `gqloom + yoga + gqlens + vite` 实现开发期 GraphQL 热更新：

- GQLoom schema 文件变更后，服务端 GraphQL handler 热替换。
- 只有 GraphQL 类型系统实际变化时，才触发 GQLens codegen。
- 只有生成文件内容实际变化时，才触发前端 HMR。
- 用户代码只使用真实 TS 文件，保证 TypeScript / IDE / 跳转 / 类型提示稳定。
- 不额外维护独立 watcher 调度系统，尽量复用 Vite module graph。

## 核心原则

### 1. 用户入口必须是真实文件

不要让业务代码直接依赖 `virtual:` 模块。

推荐结构：

```txt
src/graphql/
  schema.ts                # GQLoom schema entry，真实 TS
  yoga.ts                  # Yoga handler factory，真实 TS
  context.ts               # context / dataloader，真实 TS

  client/
    index.ts               # 前端稳定入口
    gqlens.generated.ts    # GQLens 生成物
    schema.generated.ts    # GQLens 生成物
```

前端只 import：

```ts
import { query, mutation } from "@/graphql/client";
```

服务端只 import：

```ts
import { schema } from "@/graphql/schema";
```

`virtual:` 模块只允许作为 Vite 插件内部胶水，不作为用户 API。

## HMR 主链路

```txt
src/graphql/schema.ts changed
        ↓
Vite invalidates server module graph
        ↓
插件重新加载真实 schema entry
        ↓
new GraphQLSchema
        ↓
print SDL / introspection
        ↓
compare with last in-memory SDL
        ↓
如果 SDL 内容变化：
    run/update GQLens generated files
    content-diff generated TS files
    Vite 自动让前端 importers HMR
否则：
    只更新 Yoga handler
    client 完全不动
```

## 关键判断边界

### 源码层不区分 schema / resolver

GQLoom 是 code-first，schema shape 与 resolver 通常写在同一组模块中。不要试图从源码层判断“这次只是 resolver body 变化”。

统一策略：

```txt
源码变了 → 重新 evaluate GQLoom schema → 比较派生 SDL
```

是否触发 GQLens，由 SDL / introspection 内容是否变化决定，而不是由文件名或源码分析决定。这个内容可以只保存在插件进程内；只有需要跨进程复用、调试或给其他工具消费时，才需要额外落盘。

## Yoga 热替换模式

HTTP server / Vite dev server 保持稳定，只替换当前 GraphQL handler 引用。

```txt
Vite middleware / Node server
        ↓
currentYogaHandler
        ↓
createYoga({ schema, context })
```

schema entry 更新后：

```txt
reload schema.ts
create new Yoga handler
replace currentYogaHandler
```

不要重新 listen 端口，不要重启 dev server。

## GQLens 触发模式

GQLens 不应自行 watch endpoint，也不应每次 schema 文件变更都运行。

推荐触发条件：

```txt
SDL / introspection content changed
        ↓
run GQLens codegen
        ↓
generated TS content changed
        ↓
write files
        ↓
Vite client graph HMR
```

SDL / introspection diff 不必每次都读写磁盘。dev server 生命周期内保存上一次 SDL 字符串即可；服务重启时重新生成一次 generated 文件，并在写入 generated TS 前做 content-diff。

生成文件必须使用 content-diff：

```txt
newContent === oldContent → 不写文件
newContent !== oldContent → 写文件
```

这样文件未变化时不会触发多余 FS event，也不会引起前端无意义 HMR。

## Vite 插件职责

插件只做有限职责：

1. 监听 GraphQL 相关真实模块的变更。
2. 通过 Vite module graph 重新加载 schema entry。
3. 从 `GraphQLSchema` 派生 SDL / introspection。
4. 对派生产物做内存 diff。
5. 在 schema artifact 变化时触发 GQLens codegen。
6. 对 generated TS 文件做 content-diff 写入。
7. 替换 Yoga handler 引用。

不做：

- 不维护完整独立依赖图。
- 不手动广播前端 reload。
- 不让 GQLens 轮询 endpoint。
- 不把用户类型入口设计成 virtual module。
- 不强行拆分 GQLoom schema 与 resolver。
- 不为 SDL 强制维护 `.cache` 目录；落盘 artifact 应该是可选能力，而不是 HMR 主链路的必要状态。

## 变更影响矩阵

| 变更类型                          | Yoga handler | SDL artifact | GQLens codegen |       Client HMR |
| --------------------------------- | -----------: | -----------: | -------------: | ---------------: |
| resolver 实现变化                 |         更新 |         不变 |         不触发 |           不触发 |
| query / mutation / field 类型变化 |         更新 |         变化 |           触发 | 按 importers HMR |
| input / enum / scalar 变化        |         更新 |         变化 |           触发 | 按 importers HMR |
| context / dataloader 变化         |         更新 |         不变 |         不触发 |           不触发 |
| Yoga plugin 配置变化              |         更新 |     通常不变 |     通常不触发 |           不触发 |
| GQLens config 变化                |       不一定 |       不一定 |           触发 | 按 importers HMR |
| generated 文件内容不变            |       不影响 |       不影响 |         不写入 |           不触发 |

## 设计重点

最终模型不是“三层手动 HMR”，而是：

```txt
真实源码
  → Vite server graph invalidation
  → GQLoom schema re-evaluation
  → Yoga handler hot swap

真实源码
  → GraphQLSchema
  → stable SDL / introspection snapshot
  → GQLens generated file contents
  → Vite client graph HMR
```

GraphQL 类型系统是否变化由派生产物决定；前端是否更新由真实 generated 文件是否变化决定；服务端是否更新由 Vite server graph 决定。

## 最终原则

```txt
Vite 负责追踪源码变化。
GQLoom 负责重新产出 GraphQLSchema。
SDL / introspection 快照负责判断类型系统是否变化。
GQLens 负责生成 TS 文件内容。
应用侧插件负责 output path 和 generated 文件 content-diff 写盘。
Vite client graph 负责自然传播前端 HMR。
Yoga handler 引用替换负责避免服务端重启。
```

## 复用边界

构建工具适配不属于 `@gqlens/core`：core 是 runtime/browser-facing 包，不引入 Node fs、GraphQL schema loading 或构建 hook。`@gqlens/codegen` 也不需要内置 Rolldown 插件或写盘策略；它只提供外部插件可调用的纯生成函数：

- `generateFiles()` 接受 SDL 或 `GraphQLSchema`，返回 generated 文件内容映射。构建插件里优先传 SDL 字符串，因为 monorepo/link 场景可能存在多份 `graphql` 包实例。
- 外部 Rolldown/Vite/Rspack 插件负责 output path、content-diff 写盘、watch/filter/schema loading/HMR/middleware/proxy，并在合适的 hook 中调用上述函数。

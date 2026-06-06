# 03. Selection 与查询构建

本章覆盖从字段读取到 GraphQL operation 生成的完整链路。

## Selection 收集

每次读取 scalar 字段或列表 identity，当前 QuerySession 记录一条 selection path。selection path 表达的是“UI 当前需要哪些可渲染值”，不是已经命中的 cache key。

例如：

```ts
q.user({ id: "1" }).name;
q.user({ id: "1" }).avatar;
```

收集为：

```
Query.user(id:"1").name
Query.user(id:"1").avatar
```

对应生成的 operation：

```graphql
query {
  user(id: "1") {
    name
    avatar
  }
}
```

（`id` 和 `__typename` 由 Planner 自动补齐，用户无需手动声明。）

如果中间路径尚未解析到具体实体，例如 `q.viewer.name` 首次读取，selection 仍然以 GraphQL 路径存在：

```
Query.viewer.name
```

响应返回后，cache 再把 `viewer` 这个 slot 归一到具体实体字段。

## QuerySession

QuerySession 是 selection 合并与请求调度的边界，也是 session 状态的持有者。

```
一个路由 / provider → 一个 QuerySession → 多个组件共享
```

QuerySession 不是 hook 调用次数的别名，而是 selection scope。scope 必须由会影响 operation 语义的配置决定：

```
scope = metadata + policy + ttl + transport mode + operation boundary
```

同一 scope 内的 active selection 可以合并；不同 scope 的 selection 不得混合。operation name、persisted query、Suspense / error 边界、live transport 都可能要求新的 scope。

职责：

- 维护每个 reader 最近一次 render 的 active selection 快照
- 合并 session 内所有 active selection
- 移除卸载组件的 selection
- diff 条件分支变化（if/三元导致的新旧 selection 差异）
- 调度 fetch / subscribe
- 去重 in-flight operation

reader 每次完成一次新的读取周期，都会用新 selection 替换旧 selection，而不是只追加。这一点决定了条件渲染可以自然收敛：

```tsx
return showAvatar ? q.viewer.avatar : q.viewer.name;
```

当 `showAvatar` 从 `true` 变成 `false`，`avatar` 需求会从该 reader 的 active selection 中消失。

### Prepared Selection

render-time discovery 是默认正确路径：组件 render 时读取字段，session 收集 selection，再调度请求。但这意味着“先 render 一次，才知道要请求什么”。Suspense、SSR、SSG、RSC、persisted query 和稳定 operation name 都可能要求在 render 前知道 selection。

因此 GQLens 需要保留 prepared selection 作为一等设计路径：

```ts
const userCard = defineSelection((q, v) => {
  q.user({ id: v("id") }).name;
  q.user({ id: v("id") }).avatar;
});
```

这里的 `v("id")` 是变量占位符，不是业务字符串。prepared selection 产出的是带变量 shape 的 selection path：

```
Query.user(id:$id).name
Query.user(id:$id).avatar
```

prepared selection 的约束：

- 产物必须是普通 selection path，不得绕过 QuerySession / Planner
- 参数占位符必须能映射到确定变量 shape
- 可用于提前 fetch、SSR 预取、persisted hash、静态诊断
- 不得成为 runtime 正确性的前提；没有 prepared selection 时，render-time discovery 仍必须正确

这条路径解决的是“何时知道 demand”，不是另起一套 query 语义。

典型时间线：

```
render-time discovery:
  render 组件 → 读取字段 → 得到 selection → 发请求 → 写 cache → 再 render

prepared selection:
  已知 selection → 先发请求 / 预取 / 生成 hash → render 组件 → 读取同一批字段
```

因此 prepared selection 的意义不是让用户手写 query，而是让同一套 accessor 表达可以在 render 前被使用。它主要服务于首屏、SSR、Suspense、预加载和 persisted query；普通交互式页面仍可只依赖 render-time discovery。

### Session 状态

`useQuery()` 返回的 `q` 上直接暴露请求级别的 loading 与 error：

```ts
const q = useQuery();

q.loading; // boolean：任何 in-flight request 存在时为 true（不含 live）
q.error; // Error | null：最近一次请求错误，成功时自动清空
```

### 参数

```ts
const q = useQuery({
  policy: "cache-and-network", // 默认缓存策略
  ttl: 30_000, // 默认字段 TTL（ms），0 = 永不过期
});
```

## 合并规则

| 场景                 | 行为                     |
| -------------------- | ------------------------ |
| 同一 root、同一 args | 合并字段                 |
| 同一 root、不同 args | 生成 alias               |
| 不同路径命中同一实体 | NormalizedCache 自动去重 |
| 同一字段被多次读取   | 合并为一次请求           |
| reader 卸载          | 移除其 selection         |
| 条件分支变化         | diff 新旧 selection      |

### Alias 示例

```ts
q.user({ id: "1" }).name;
q.user({ id: "2" }).name;
```

生成：

```graphql
query {
  user_1: user(id: "1") {
    id
    __typename
    name
  }
  user_2: user(id: "2") {
    id
    __typename
    name
  }
}
```

## 请求调度

### Microtask 批处理

默认采用 microtask 级批处理：同一 render 周期中所有组件 mount / update 后，收集到的 selection 在一个 microtask 中合并、生成一个 GraphQL operation、发出一次请求。

```
组件 A mount  → 读 q.user({ id: "1" }).name       ┐
组件 B mount  → 读 q.user({ id: "1" }).avatar     ├─ 同一 microtask
组件 C mount  → 读 q.user({ id: "2" }).name       ┘
                                                    │
                                            ┌───────┘
                                            ▼
                         合并为一次请求（两个 alias），发出 fetch
```

若组件在 useEffect、用户交互等异步时机读取字段，则各自进入新的 microtask 批次。这保证了「同一帧 = 一趟请求」，同时去重 in-flight 的重复 operation。

调度只关心 active selection，而不是“谁触发了读取”。这让缓存过期、mutation invalidation、组件 mount 都可以收敛到同一个请求模型：某些 active demand 缺失或 stale，于是 session 安排一次新的 fetch。

### 变量提取

Planner 将 args 按 **canonical JSON 序列化**（key 排序）后比较：相同 serialized value 的 selection 合并为一个 field，值不同则生成 alias。变量名 (`$v0`, `$v1`, ...) 由 Planner 自动生成，与源码形式无关。

```ts
q.user({ id: "1" }).name; // → $v0 = "1"
q.user({ id: someVar }).name; // 若 someVar === "1"，合并到同一个 field
// 若 someVar !== "1"，生成 alias $v1
```

## Planner

Planner 将一组 selection path 转换为 GraphQL operation。

```
输入：selection path 的扁平集合
输出：合并后的 GraphQL operation
```

| 职责                  | 说明                                    |
| --------------------- | --------------------------------------- |
| field merge           | 将同一 root 下的字段合并为嵌套结构      |
| args canonicalization | 统一参数序列化格式                      |
| alias                 | 同字段不同 args 时自动生成别名          |
| variable extraction   | 将内联参数提升为 `$var` 变量            |
| inline fragment       | 将 `$on.<TypeCondition>` 渲染为类型分支 |
| operation name        | 生成稳定、确定性的 operation name       |
| identity fields       | 自动补齐 `id` 和 `__typename`           |

Planner 的输入除了 selection path，还应包括 schema / codegen 元数据。它不应通过 JS 值猜测 GraphQL 类型，也不应在不知道返回类型的情况下盲目补 `id`。

alias、fragment、directive 这类 GraphQL operation 语义属于 Planner / metadata 层。用户 accessor 只表达字段路径和 args；不得把 alias 命名、任意 directive 链、GraphQL document string 暴露成字段链 API。

示例输入：

```
Query.user(id:"1").name
Query.user(id:"1").avatar
Query.user(id:"1").posts(first:10).title
```

输出：

```graphql
query UserDemand($id: ID!) {
  user(id: $id) {
    id
    __typename
    name
    avatar
    posts(first: 10) {
      id
      __typename
      title
    }
  }
}
```

## 查询策略

缓存策略决定 fetch 传输模式下如何协调缓存与网络：

| 策略                | 语义                                       |
| ------------------- | ------------------------------------------ |
| `cache-first`       | 有缓存直接返回，缺失字段另行请求           |
| `cache-and-network` | 先返回缓存，同时后台 fetch（**推荐默认**） |
| `network-only`      | 跳过缓存，直接请求并写入                   |

默认策略为 `cache-and-network`——对 web 场景而言，它在即时响应与数据时效性之间取得最佳平衡。

stale 字段按“仍可读、但需要后台刷新”处理：

```ts
q.viewer.name; // 返回旧值，同时该 active demand 进入下一次 refetch
```

这样 UI 不会因为 TTL 或 invalidation 瞬间变空，但数据仍会向服务器校准。

## Live 查询

live 不是缓存策略，而是独立的**持续订阅形态**。它通过外部提供的订阅函数替代一次性 fetch：

```ts
const live = useLiveQuery();
live.user({ id }).name; // 同一套 accessor API
```

GQLens 的核心契约是 `LiveSubscriber`，不是某个具体协议。外部可以用 WebSocket、SSE 或业务已有实时通道实现它；session 只负责 selection 变化时重新订阅、组件卸载时取消订阅，并把收到的 patch 写入对应 field signal。

live 与 fetch 的差异只在传输层：live patch 仍写入同一个 NormalizedCache，reader 仍通过字段 signal 被通知。

需要区分两个概念：

```
reactive query = field signal 变化会通知 reader
live query     = 持续传输把远端 patch 写入 cache
```

所有 GQLens query 都是 reactive；只有使用 `LiveSubscriber` 的 session 才是 live transport。这个命名边界防止 cache reactivity、SWR、GraphQL subscription、SSE / WebSocket 被混成一个概念。

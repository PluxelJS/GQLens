# 03. Selection 与查询构建

本章覆盖从字段读取到 GraphQL operation 生成的完整链路。

## Selection 收集

每次字段读取，当前 QuerySession 记录一条 selection path。例如：

```ts
q.user({ id: "1" }).name()
q.user({ id: "1" }).avatar()
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

## QuerySession

QuerySession 是 selection 合并与请求调度的边界。

```
一个路由 / provider → 一个 QuerySession → 多个组件共享
```

职责：

- 维护每个 reader 的 active selection 快照
- 合并 session 内所有 active selection
- 移除卸载组件的 selection
- diff 条件分支变化（if/三元导致的新旧 selection 差异）
- 调度 fetch / subscribe
- 去重 in-flight operation

## 合并规则

| 场景                     | 行为                     |
| ------------------------ | ------------------------ |
| 同一 root、同一 args     | 合并字段                 |
| 同一 root、不同 args     | 生成 alias               |
| 不同路径命中同一实体     | NormalizedCache 自动去重 |
| 同一字段被多次读取       | 合并为一次请求           |
| reader 卸载              | 移除其 selection         |
| 条件分支变化             | diff 新旧 selection      |

### Alias 示例

```ts
q.user({ id: "1" }).name()
q.user({ id: "2" }).name()
```

生成：

```graphql
query {
  user_1: user(id: "1") { id __typename name }
  user_2: user(id: "2") { id __typename name }
}
```

## Planner

Planner 将一组 selection path 转换为 GraphQL operation。

```
输入：selection path 的扁平集合
输出：合并后的 GraphQL operation
```

| 职责               | 说明                                   |
| ------------------ | -------------------------------------- |
| field merge        | 将同一 root 下的字段合并为嵌套结构     |
| args canonicalization | 统一参数序列化格式                  |
| alias              | 同字段不同 args 时自动生成别名        |
| variable extraction| 将内联参数提升为 `$var` 变量          |
| operation name     | 生成稳定、确定性的 operation name     |
| identity fields    | 自动补齐 `id` 和 `__typename`         |

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

| 策略               | 语义                                       |
| ------------------ | ------------------------------------------ |
| `cache-first`      | 有缓存直接返回，缺失字段另行请求           |
| `cache-and-network`| 先返回缓存，同时后台 fetch（**推荐默认**）|
| `network-only`     | 跳过缓存，直接请求并写入                   |

默认策略为 `cache-and-network`——对 web 场景而言，它在即时响应与数据时效性之间取得最佳平衡。

## Live 查询

live 不是缓存策略，而是独立的**传输模式**。它通过持续订阅（WebSocket / SSE）替代一次性 fetch：

```ts
const live = useLiveQuery()
live.user({ id }).name()   // 同一套 accessor API
```

一个 QuerySession 内共享一条 live 连接。服务端按 root + args 区分不同 selection，推送 patch 到对应 field signal。组件卸载时对应的 selection 从 session 移除，不影响其他组件的订阅。不需要手动管理连接生命周期。

# 07. GQty 对照

GQLens 最初受 GQty 启发：不要手写 GraphQL query，而是让 UI 读取什么，客户端就收集什么 selection。这个方向是成立的，GQLens 不应把 GQty 当成反例。

对照 GQty 的价值在于看清两条路线的分歧：**同样是从字段读取推导 query，字段模型究竟建立在 data proxy 上，还是建立在 schema-generated accessor contract 上**。

## 共同前提

GQty 和 GQLens 共享几个关键判断：

- UI 字段读取可以成为数据需求的来源
- selection 可以跨组件合并，减少手写 query 和手动 batching
- cache miss / stale 可以由 active demand 驱动 fetch
- normalized cache 是跨路径共享实体更新的必要条件
- 读取 API 必须保留 TypeScript 对 schema 变化的反馈

这些判断构成 GQLens 的设计谱系。GQLens 的分歧不是“是否自动生成 query”，而是自动生成 query 的边界放在哪里。

## 分歧轴

| 设计轴         | GQty 路线                                         | GQLens 路线                                                               |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| 字段模型       | 读 data proxy，运行时捕获访问                     | 读 schema-generated accessor，生成代码定义可访问边界                      |
| selection 来源 | 与 cache/object proxy 交互时捕获                  | 读取 scalar 字段或列表 identity 时记录 path                               |
| 对象关系       | 稳定 object/proxy reference 是主要体验            | 不把 entity object 暴露为响应式对象；公开 scalar value、accessor、ID 列表 |
| 列表           | 像数组一样遍历 data proxy                         | 列表 identity 与行字段拆分，`ids` 是成员/顺序信号                         |
| scope          | scoped query 防止不同上下文 selection 混合        | QuerySession 是显式合并边界，scope key 必须由配置决定                     |
| Suspense / SSR | 需要 prepare 避免纯 render discovery 的额外轮次   | prepared selection / compiler extraction 必须成为可选正路                 |
| live           | cache subscription 意义上所有 query 都是 reactive | reactive query 与 live transport 分开命名                                 |

## GQLens 从 GQty 保留的洞见

### 1. “读 cache 触发 fetch”是正确抽象

GQty 的强洞见是：用户并不想维护 query 文本，而是想和类型化数据模型交互；缺失的数据由客户端补齐。GQLens 保留这个方向，但把“读 cache object”改成“读 field signal”。

因此 GQLens 的核心公式是：

```
field read = declare demand + read reactive value
```

这不是 Apollo/urql 式 operation-first，也不是把 GraphQL 文本藏进 hook；它仍然是 demand-first。

### 2. scope 必须是设计对象

GQty 的 scoped query 说明一个事实：selection 不应无限全局合并。operation name、cache policy、Suspense 边界、persisted query、transport mode 都可能要求 selection 分组。

GQLens 因此必须把 QuerySession 当成显式 scope，而不是把 `useQuery()` 调用次数等同于请求边界。

```
scope = metadata + policy + ttl + transport + operation boundary
```

同一 scope 内的 active selection 可以合并；不同 scope 的 selection 不得混合。

### 3. render-time discovery 不足以覆盖所有场景

GQty 的 prepare 机制指出了 render discovery 的边界：Suspense、SSR、SSG、RSC、persisted query 都希望在真正渲染前知道 selection。

GQLens 的 AST 插件不能成为正确性前提，但 prepared selection 必须是设计上的一等路径：

```ts
const userCard = defineSelection((q, v) => {
  q.user({ id: v("id") }).name;
  q.user({ id: v("id") }).avatar;
});
```

运行时读取仍然正确；prepared selection 只用于提前调度、稳定 operation name、persisted hash、SSR 预取和静态诊断。

### 4. normalized cache 必须仍然 reactive

GQty 强调 normalized 后仍要保持响应式：同一实体在不同路径出现，任何路径更新都应通知其他路径 reader。

GQLens 的选择是把这个性质下沉到 field signal：

```
viewer.name        → User:1.name signal
post.author.name   → User:1.name signal
```

这样可以避免把整个 object/proxy reference 作为响应式边界。

## GQLens 刻意不同的地方

### 1. 不暴露响应式 entity object

GQLens 不把 `User` 当作会变化的 JS object 暴露给 UI。entity accessor 只是路径镜头；真正的响应式值是 scalar field signal、relation slot 和 list identity。

这个选择牺牲了“像普通对象一样 map / 展开 / 传递”的体验，换来更窄的订阅边界：

- 不订阅整个对象
- 不要求稳定 object reference
- 不需要处理 object proxy 的枚举、展开、序列化、Promise assimilation
- 行组件可以按 ID 重新进入 entity 字段读取

### 2. 列表不是实体数组，而是 identity slot

GQty 的数组体验更自然；GQLens 的列表体验更刻意：

```ts
const ids = q.todos({ done: false }).ids;
const title = q.todo({ id }).title;
```

这不是用户语法偏好，而是缓存边界判断。列表成员、顺序、分页窗口属于 relation identity；行字段属于 entity field。两者 invalidation、TTL、通知粒度不同。

### 3. “live”只表示持续传输

GQty 语境中，query 因为订阅 cache 而是 live 的。GQLens 避免复用这个词：普通 query 当然是 reactive，但 **live query** 只表示外部持续传输。

```
reactive query = field signal 会通知 reader
live query     = subscribe(op, onData, onError) 持续写入 cache
```

这个命名边界防止 cache reactivity、SWR、GraphQL subscription、SSE/WebSocket 被混成一个概念。

## 设计结论

GQLens 应继续承认 GQty 的启发：**从字段读取推导 selection 是正确方向**。

GQLens 的独立判断是：

- 字段访问边界由 codegen 生成，而不是由 runtime trap 接管
- 响应式边界是 field signal，而不是 object proxy
- 列表边界是 identity slot，而不是 entity object array
- scope 是显式 session contract，而不是 hook 调用副产物
- prepared selection 是 Suspense / SSR / persisted query 的正路，但不是 runtime 正确性的前提

这组分歧比“getter vs Proxy”更重要，也更能决定 GQLens 是否值得作为独立设计存在。

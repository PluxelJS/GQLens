# 设计记录：Plan 缓存 · Prepared Selection · Selection Scope · 并发竞态

四项设计关注点：Plan 缓存、Prepared Selection、Selection Scope、并发竞态。当前已经落地的是 exact SIEVE plan cache、PreparedSelection bind 与运行时入口、hook-local 默认 scope、旧请求响应保护。未来可选的是 value-independent shape-template planner。

当前结论：先采用 **exact selection plan cache + SIEVE 淘汰**，不把 planner 拆成 value-independent template。这个方案更符合当前阶段的原则：语义显式、实现短、正确性边界清楚、性能收益覆盖大多数重复 render / refetch 场景。两阶段 shape-template planner 先作为未来可选能力保留，不作为当前目标。

## 问题一：Plan 缓存粒度

### 现况

`plan()` 每次调用走完整 pipeline：`buildTree` → `renderNodes` → `createVariableRegistry`。Session 的 `operationKey` 是 `query + "\n" + JSON.stringify(variables)`。

`user(id: 1)` 和 `user(id: 2)` 的字段 shape 相同，但变量值不同。它们通常不应该共享请求结果，也不应该用同一个 `completed` 结果判断 freshness；否则会把不同参数的数据边界混在一起。

真正可优化的是 planner 生成成本：同一个 session 中完全相同的 selection 集合反复出现时，不需要每次重建 tree、重渲染 GraphQL 文本和重新计算 `PlannedSelectionPath`。

### 当前方案

在 `QuerySession` / `LiveQuerySession` 内维护一个 per-session plan cache：

```text
cache key = operationType + sorted(selectionKey(paths))
cache value = GraphQLOperation
eviction = SIEVE bounded cache
```

这个 key 是 exact key：包含字段路径和参数值。它不尝试把 `id=1` 与 `id=2` 合并成同一个模板，因此不会改变当前 planner 的 sibling 区分、alias、变量槽位和 cache 写入语义。

SIEVE 的意义是控制长生命周期 session 下的缓存增长，同时避免 LRU 那种每次命中都重排结构的写放大。命中只标记 `visited`，淘汰时给近期访问过的 entry 一次机会。

### 为什么暂缓 shape-template planner

把「shape → query 模板」和「value → variables」完全拆开确实可以让 `id=1` / `id=2` 共享 query 模板，但它不是一个局部改动。

当前 `buildTree()` 依赖 `stepKey(step)`，而 `stepKey` 用 args 值区分 sibling。这个设计保证了同一个 selection 中的下面两条路径不会被错误合并：

```ts
void q.user({ id: "1" }).name;
void q.user({ id: "2" }).name;
```

如果直接把值从 shape key 中拿掉，两个 `user` sibling 会合并，alias、responseKey、slot sync 都会出错。正确的两阶段 planner 需要新的中间表示：既不能把不同 sibling 合并，又要让变量值变化时复用模板。这会牵涉 shape key、变量槽位、alias 分配、`PlannedSelectionPath` 映射和 persisted query hash 的整体设计。

因此当前不做半截 shape-template。它适合未来在两个条件成立时再做：

- profiler 证明 planner CPU 成为真实瓶颈，而不是网络 / render / cache normalize。
- 需要 persisted query、SSR 预取或高频 hover/prefetch 这类模板级能力。

## 问题二：Prepared Selection 接入

### 原问题

`defineSelection()` 能跑虚拟 accessor 收集出 `PreparedSelection { paths, variables: string[] }`。早期 session 只接受来自组件 render 时逐个推送的 `SelectionPath`，没有任何接口消费一整组 prepared path。

当时缺口有三个：

- **没有 bind 机制**：路径中的 `VariablePlaceholder`（如 `{ __gqlensVariable: "id" }`）需要被替换为具体值。
- **session API 缺失**：session 的 `select()` 是按 reader 逐路径追加的，没有「注册一组预编译 path + 变量绑定」的入口。
- **re-render 驱动模型不匹配**：render-time discovery 依赖组件 render 时的 signal 读来订阅变化；prepared 模式下需要显式变量作为触发源。

### 本质矛盾

`defineSelection` 产出的本质是显式 selection contract：页面或模块可以把「需要哪些数据」从 render-time discovery 中提取出来，让请求边界更容易阅读、测试和迁移。

它不必强行等同于 planner template。当前阶段更重要的是让 prepared selection 能进入现有 session 管道，而不是为了模板缓存重构 planner。

### 当前方案

让 adapter 消费 `PreparedSelection`，且与 render-time discovery 共享后续的 plan/fetch/cache 管道。关键是两点：

1. bind：把 `VariablePlaceholder` 替换为具体值，产出可 planner 消费的 `SelectionPath[]`
2. 变量变化触发：adapter 在变量变化后重新 bind → plan → 走正常调度流程

这样 prepared 模式不另起炉灶——它只是 demand 的来源不同，后续一切不变。变量变化时重新 bind，产出普通 `SelectionPath[]`，再进入 exact SIEVE plan cache 和正常 session 调度。

未来如果实现 shape-template planner，prepared selection 可以成为天然入口；但当前实现不依赖这个前提。

## 问题三：Selection Scope 过粗导致跨页面 overfetch

### 原问题

React adapter 早期按 provider runtime 复用 `QuerySession`：

```text
GQLensProvider
  └─ session key = policy + ttl + metadata
       ├─ reader A: plugin overview selections
       ├─ reader B: plugin detail selections
       └─ reader C: package / route-local selections
```

`SelectionCollector.snapshot()` 会把同一 session 下所有 active reader 的 paths 合并，然后交给 `plan(paths)` 生成一个 operation。只要多个页面区域或多个 route-level provider 同时处于 mounted 状态，一次 GraphQL 请求就会包含它们的 selection 并集。

这不是 GraphQL 服务端过度返回，也不是 planner 自己扩展 schema；它是 session selection 边界过大：

```text
请求内容 = 当前 QuerySession 中所有 active reader 的 selection 并集
而不是 = 当前页面 / 当前组件 / 当前用户动作需要的 selection
```

在 Pluxel 中会表现为：进入插件详情页时，overview 查询和 detail 查询共用同一个 session；某个 `refetch()` 或 selection 变化会把两边的 active selection 一起带上。

### 问题

全局 session 合并 selection 有一个优点：天然 batch 多个组件的读取，减少 waterfall。但作为默认语义，它隐含了几个问题：

- **请求边界不直观**：开发者读一个页面组件，无法从本地代码判断最终 operation 是否还包含别处 mounted 的 selection。
- **refetch 范围过大**：某个页面局部 `query.refetch()` 实际 refetch 整个 session 的 active selection。
- **cache-first 粒度变粗**：只要合并后的任一路径 stale，整个 operation shape 都可能被重新请求。
- **LLM 不易推理**：selection 来源是运行时 mounted tree 的并集，而不是显式 API contract。
- **页面切换和布局保活会 overfetch**：router、tabs、side panels、layout providers 只要没有 unmount，就仍在同一个 operation 边界里。

这与 Plan 缓存不是同一个问题。Plan 缓存解决「相同 selection 集合的 plan 生成成本」；Selection Scope 解决「哪些 paths 应该属于同一个 operation」。如果 scope 错了，Plan 再快也只是更快地生成一个过大的 operation。

### 当前方案

GQLens 应该把 **cache 共享** 和 **operation selection 边界** 分开：

```text
Provider store     全局共享：entity field / root slot / relation slot 写入同一个 GraphDataStore
QuerySession       按 scope 隔离：每个 scope 有自己的 collector、inflight、completed、loading、error
Selection reader   按 hook 实例挂载：只代表当前 hook render 读到的 paths
```

换句话说：

```text
共享 cache，不共享 selection collector
共享数据一致性，不共享请求边界
```

默认行为应偏向局部、可预测；需要 batch 时由开发者显式声明 scope。

### 推荐 API

#### 1. hook-local session 作为默认

`useQuery()` 默认创建 hook-local session。多个 hook 仍然共享 provider cache，但不会自动合并成一个 operation。

```ts
const q = useQuery();
```

语义：

```text
operation selection = 当前 hook render 期间读到的 paths
refetch()           = 当前 hook 的 paths
cache               = provider 级共享 cache
```

这是最易推理的默认值，适合页面、详情面板、表单、卡片等绝大多数场景。

#### 2. 显式 scope 用于有意 batch

当多个组件确实应该共享一个 operation，可以传入稳定 scope：

```ts
const q = useQuery({ scope: "plugin-overview" });
```

语义：

```text
相同 scope + 相同 policy/ttl/metadata -> 共享 QuerySession
不同 scope                            -> 独立 QuerySession
未传 scope                            -> hook-local QuerySession
```

scope 是 operation boundary，不是 store namespace。不同 scope 查询到同一 entity 时仍写入同一个 GraphDataStore。

#### 3. Prepared query 用于页面级稳定 operation

页面级查询更适合显式 prepared selection：

```ts
const pluginDetailSelection = defineSelection((q, v) => {
  const plugin = q.plugin({ id: v("id") });
  void plugin.name;
  void plugin.detail.dependencies.ids;
});

const q = usePreparedQuery(pluginDetailSelection, { id: pluginName });
```

语义：

```text
operation paths 由 selection 定义
变量变化显式 rebind，走同一套 session 调度
refetch 只覆盖这个 prepared operation
```

这能把「页面需要什么数据」从隐式 render discovery 中提取出来，成为稳定 contract。render-time discovery 仍保留，作为局部、渐进读取模型。

### 推荐内部结构

Provider runtime 不应只维护一个 `sessions: Map<sessionKey, QuerySession>`，而应区分 session key 和 scope key：

```ts
type QueryScope =
  | { kind: "local"; id: number }
  | { kind: "shared"; name: string }
  | { kind: "prepared"; name: string };

type SessionKey = {
  policy: QueryPolicy;
  ttl: number;
  metadataId: number;
  scope: QueryScope;
};
```

React adapter 可以用 `useRef()` 生成 hook-local id：

```ts
const localScope = useRef(nextLocalScope());
const scope = config.scope ? sharedScope(config.scope) : localScope.current;
```

这样 `useQuery()` 的默认行为无需开发者传参，且不会跨页面 overfetch。

### 与 Prepared Selection 的关系

Selection Scope 和 Prepared Selection 是互补关系：

- scope 解决 operation 边界：哪些 paths 可以被合并
- prepared selection 解决 operation contract：paths 从哪里来、变量如何绑定

最终模型应该是：

```text
render-time discovery ──┐
                        ├─ scope-local collector ── exact plan cache ── fetch
prepared selection  ────┘
```

同一个 scope 内可以混合 render-time paths 和 prepared paths，但默认不应跨 scope 合并。

### Pluxel 迁移建议

Pluxel 这类 plugin-centric UI 应按页面/面板拆 scope：

```text
plugin overview route     scope: "plugin-overview"
plugin detail route       scope: "plugin-detail:<pluginName>"
package manager route     scope: "package-manager"
ops explorer route        scope: "ops-explorer"
```

更进一步，稳定页面查询应该改成 prepared query：

```text
pluginOverviewSelection
pluginDetailSelection(pluginName)
packageInventorySelection
```

这样网络请求会贴近页面意图：

```text
overview refetch 不会带上 detail selection
detail refetch 不会带上 overview selection
package manager 不会受插件页 mounted 状态影响
```

### 不推荐方案

不建议用 fetcher 层去拆 query 或过滤 selection。到 fetcher 时 operation 已经被 planner 合并，边界信息丢失；在这里做拆分会破坏 loading/error/refetch/inflight/completed 的语义一致性。

也不建议让业务组件手动 unmount layout/provider 来避免 overfetch。UI mounted 状态不应该承担数据请求边界的职责。

## 合流后的结构

```
                      ┌── render-time discovery ──────────┐
                      │  (组件 render → demand → 累积)      │
                      └──────────┬────────────────────────┘
                                 │ SelectionPath[]
                      ┌──────────┴────────────────────────┐
                      │  (或 prepared selection + bind)    │
                      └──────────┬────────────────────────┘
                                 │
                  ┌──────────────▼──────────────┐
                  │  exact SIEVE plan cache       │
                  │  key = selectionKey(paths)    │
                  │  miss → plan(paths)           │
                  └──────────────┬──────────────┘
                                 │
              ┌──────────────────▼──────────────────┐
              │  Session 调度（语义不变）             │
              │  inflight / completed / fetch /      │
              │  normalize / signal notify           │
              └─────────────────────────────────────┘
```

两个入口走同一套 scope-local session 管道，区别只在 selection 来源：

- render-time：组件 render 期间通过 accessor demand paths
- prepared：预先定义 paths，运行时 bind variables 后 demand paths
- scope：决定哪些 render-time paths / prepared paths 可以被合并进同一个 operation

## 未来可选能力

以下能力需要真正的 shape-template planner 或更明确的 query descriptor，不属于当前 exact cache 的承诺：

| 能力                | 需要的额外设计                                        |
| ------------------- | ----------------------------------------------------- |
| persisted query     | shape 模板 hash，运行时只发 hash + variables          |
| 稳定 operation name | defineSelection 命名进入 planner / transport contract |
| Suspense / SSR 预取 | component 渲染前的 prepared fetch API                 |
| hover / 预加载      | 事件回调中提前 bind + fetch，不依赖 render            |
| 模板级性能优化      | value-independent shape key + stable variable slots   |

当前已经获得的是请求边界可解释性、prepared selection 可消费、重复 exact plan 可缓存、并发旧响应不会覆盖新状态。

## 问题四：并发 fetch 的缓存覆盖竞态

### 现况

`inflight` 去重基于 `operationKey` —— 完整 query 文本 + 变量值 JSON。当组件 selections 在飞行中变化时，新旧请求的 query 文本不同，key 不同，`inflight` 不拦截。

```
组件 render → 读 q.user({id:"1"}).name
  → plan A: query { user(id: $v0) { name } }    → fetch A 开始（慢）

组件 re-render → 读 q.user({id:"1"}).name, q.user({id:"1"}).avatar
  → plan B: query { user(id: $v0) { name avatar } } → fetch B 开始（快）

B 先返回 → 写 cache: User:1.name="Bob", User:1.avatar="url"
A 后返回 → 写 cache: User:1.name="Alice"  ← 覆盖了 B 的 "Bob"
```

结果：`name="Alice"`（A 的过时数据）但 `avatar="url"`（B 的新数据）——实体处于不一致状态。

### 为何与 GQty #2001 不同

GQty 的同名 issue 源于 proxy selection 管理和响应处理耦合——响应可能清除 proxy 的 selection 状态导致 `SubSelectionRequired`。GQLens 的 collector 和 response 已分离，不存在这个问题。

但 GQLens 的 root cause 是另一个层面的：`cache.normalize()` 按字段无条件覆盖写入，`inflight` 去重粒度是完整 query 文本而非实体字段集合。两者叠加，旧响应中与新响应重叠的字段会被过时数据覆盖。

### 可能的方向

核心矛盾不是「要不要去重并发请求」，而是「过时的响应不应该覆盖更新的缓存数据」。解决路径可以从两个角度切入：

- **请求侧**：引入单调递增版本号，响应写入前检查是否仍是最新请求；或让 `inflight` 按「实体+字段」粒度去重而非按完整 operation 去重
- **写入侧**：`normalizeEntity` 写入字段前比较 TTL（如果已有更新鲜的值则跳过）；或让每个请求携带发起时刻的时间戳，与字段当前的写入时间戳比较

### 当前方案

采用请求侧单调版本号。每次真正发起 fetch 时递增 `latestRequest`；响应成功或失败回来时，只有仍等于最新版本的请求可以写 cache、更新 completed 或写 error。旧请求仍会正常从 `inflight` 中移除，因此 `loading` 能在所有请求 settle 后回到 false。

这个方案选择的是「最新 selection 胜出」。它比字段级写入时间戳简单，且直接覆盖已确认的竞态：旧的窄查询不再能覆盖新的宽查询结果，旧失败也不会污染新成功后的 `error`。

# 精进：Plan 模板缓存 & Prepared Selection 集成

两项高收益改进指向同一个基本问题：**当前 planner 把 shape 和 values 焊死了**。这导致去重粗糙、defineSelection 产出无法被 session 消费、persisted query 无路可走。

## 问题一：Plan 模板无法缓存

### 现况

`plan()` 每次调用走完整 pipeline：`buildTree` → `renderNodes` → `createVariableRegistry`。Session 的 `operationKey` 是 `query + "\n" + JSON.stringify(variables)`。

后果：`user(id: 1)` 和 `user(id: 2)` 虽然是同一个 shape，但 query 文本不同、key 不同——inflight / completed 去重完全失效。用户快速切换列表项时，每次都是全量重建树、重渲染文本、发射独立请求。

### 本质矛盾

Planner 的结构是合适的——从 SelectionPath 到 tree 到 GraphQL 文本——但它把 shape 计算和 value 注入混在一次调用中。实际上 `buildTree()` 的结果只依赖字段路径和变量名称（不依赖值），`renderNodes()` 的模板部分同理。值只在最后注入变量声明和变量字典时才需要。

Shape 是慢变信号（字段路径由组件结构决定，极少变），value 是快变信号（用户交互驱动）。当前把它们耦合在一起，快变拖垮慢变缓存。

### 可能的方向

把「shape → query 模板」从「value → 完整 operation」中分离出来。Shape 阶段产物可被缓存，只在 selection path 集合真正变化时失效。Value 注入是轻量替换，不需要重跑 tree build 和文本渲染。

这要求 planner 输出一个中间表示，至少包含：query 模板文本（变量位置已就绪）、变量类型声明、PlannedSelectionPath 映射。Session 的 operationKey 也应拆为 shapeKey + variables 两部分，使并发请求的去重粒度从「完整 operation」提升到「shape 级别」。

## 问题二：Prepared Selection 产出无处可去

### 现况

`defineSelection()` 已实现，能跑虚拟 accessor 收集出 `PreparedSelection { paths, variables: string[] }`。但 session 只接受来自组件 render 时逐个推送的 `SelectionPath`，没有任何接口消费一整组 prepared path。

### 缺口

三个：

- **没有 bind 机制**：路径中的 `VariablePlaceholder`（如 `{ __gqlensVariable: "id" }`）需要被替换为具体值，但当前没有哪一层负责这件事
- **session API 缺失**：session 的 `select()` 是按 reader 逐路径追加的，没有「注册一组预编译 path + 变量绑定」的入口
- **re-render 驱动模型不匹配**：render-time discovery 依赖组件 render 时的 signal 读来订阅变化；prepared 模式下没有这个环节，需要显式变量 signal 作为触发源

### 本质矛盾

`defineSelection` 产出的本质就是模板——和问题一的 shape 模板是同一个概念。prepared selection 的 paths 里包含了 `VariablePlaceholder`，正是 planner shape 阶段需要的输入格式。当前它们分在两条不相交的路径上：render-time discovery 走完整 pipeline，defineSelection 只到 path collection 就停了。

### 可能的方向

让 session 能够消费 `PreparedSelection`，且与 render-time discovery 共享后续的 plan/fetch/cache 管道。关键是两点：

1. bind：把 `VariablePlaceholder` 替换为具体值，产出可 planner 消费的 `SelectionPath[]`
2. 变量 signal 订阅：当 bindings 中的 signal 变化时，重新 bind → plan → 走正常调度流程

这样 prepared 模式不另起炉灶——它只是 demand 的来源不同，后续一切不变。

与问题一合在一起看：defineSelection 产出的 paths 天然适配两阶段 planner。Shape 阶段直接使用 VariablePlaceholder 走 `buildTree()`，模板缓存后任何变量值组合只需轻量 bind。

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
                  │  plan shape (慢变，可缓存)    │
                  │  buildTree → query 模板       │
                  │  → Template                  │
                  └──────────────┬──────────────┘
                                 │
                  ┌──────────────▼──────────────┐
                  │  bind values (快变)          │
                  │  注入变量值 → Operation       │
                  └──────────────┬──────────────┘
                                 │
              ┌──────────────────▼──────────────────┐
              │  Session 调度（语义不变）             │
              │  inflight / completed / fetch /      │
              │  normalize / signal notify           │
              └─────────────────────────────────────┘
```

两个入口走同一套两阶段 planner，区别只在 Phase 1 触发时机：

- render-time：selection path 集合变化时失效模板缓存
- prepared：首次注册时建模板，后续只 rebind

## 附带解锁

| 能力                | 为何自然获得                                         |
| ------------------- | ---------------------------------------------------- |
| persisted query     | shape 模板可以 hash，运行时只发 hash + variables     |
| 稳定 operation name | defineSelection 的命名可替代当前硬编码 `"GQLens"`    |
| Suspense / SSR 预取 | component 渲染前即可通过 prepared selection 发起请求 |
| inflight 去重增强   | 同一 shape 的并发不同入参共享 inflight 槽            |
| hover / 预加载      | 事件回调中提前 bind + fetch，不依赖 render           |

# GQLens 设计文档

## Design Snapshot

- GQLens 是 demand-first GraphQL client：字段读取声明 selection，并读取 field signal。
- 字段访问是 schema-generated accessor contract，不是 Proxy trap。
- 可读取终点只有 scalar 字段和列表 identity；关联字段只推进 path。
- `undefined` 表示 missing；`null` 表示服务端 null；stale 返回旧值并触发 active demand refetch。
- 列表只暴露 identity：`q.todos(args).ids`；行字段必须通过显式 root accessor 读取。
- QuerySession 是 selection scope；不同 operation / transport / policy scope 不得混合。
- NormalizedCache 的响应式单位是 entity field signal 和 root / relation slot。
- `q.user({ id })` 返回 accessor，不返回数据对象或对象级 signal。
- prepared selection 只提前产出 selection path，不替代 runtime discovery，也不是正确性前提。
- live query 只表示持续传输；普通 query 也是 reactive。
- codegen / AST 插件只能优化和静态化，不能成为 runtime 正确性前提。

| 章节                                                   | 内容                                                      |
| ------------------------------------------------------ | --------------------------------------------------------- |
| [01-总览](./01-总览.md)                                | 定位、核心公式、系统分层、不变量                          |
| [02-字段访问](./02-字段访问.md)                        | Accessor Graph、字段函数形态、列表模式、Codegen、AST 插件 |
| [03-Selection 与查询构建](./03-Selection与查询构建.md) | Selection 收集、QuerySession、合并规则、Planner、查询策略 |
| [04-Normalized Cache](./04-Normalized-Cache.md)        | 存储模型、路径归一、深层对象规则、接口、一致性            |
| [05-写入](./05-写入.md)                                | Mutation、Optimistic Update、Invalidation、冲突处理       |
| [06-框架适配](./06-框架适配.md)                        | React adapter、Solid adapter、API 对照                    |
| [07-GQty 对照](./07-GQty对照.md)                       | 设计谱系、共同前提、分歧轴、GQLens 独立判断               |
| [08-性能模型](./08-性能模型.md)                        | accessor 成本、field signal 粒度、懒创建、GQty 成本对照   |

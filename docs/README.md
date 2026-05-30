# GQLens 设计文档

| 章节 | 内容 |
| ---- | ---- |
| [01-总览](./01-总览.md) | 定位、核心公式、系统分层、不变量 |
| [02-字段访问](./02-字段访问.md) | Accessor Graph、字段函数形态、列表模式、Codegen、AST 插件 |
| [03-Selection 与查询构建](./03-Selection与查询构建.md) | Selection 收集、QuerySession、合并规则、Planner、查询策略 |
| [04-Normalized Cache](./04-Normalized-Cache.md) | 存储模型、路径归一、深层对象规则、接口、一致性 |
| [05-写入](./05-写入.md) | Mutation、Optimistic Update、Invalidation、冲突处理 |
| [06-框架适配](./06-框架适配.md) | React adapter、Solid adapter、API 对照 |

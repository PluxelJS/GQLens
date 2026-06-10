# 精进：GQLensSchemaContract 单一事实源

`GQLensSchemaContract` 是 codegen 与 runtime 之间唯一的 schema 语义契约。它不是 GraphQL 原始 schema 的运行时副本，而是 GQLens 执行 planner、accessor、normalize、invalidation、mutation result 写入时需要的最小事实集合。

## 核心结论

生成物只暴露一个 runtime schema 值：

```ts
export const gqlensSchema: GQLensSchemaContract;
```

runtime 只消费这份 contract，不再定义同构结构、中间视图或 adapter 私有 schema 描述。

## Contract 内容

```ts
interface GQLensSchemaContract {
  readonly query: GQLensObjectContract;
  readonly mutation?: GQLensObjectContract | undefined;
  readonly objects: Readonly<Record<string, GQLensObjectContract>>;
}

interface GQLensObjectContract {
  readonly type: string;
  readonly kind: "entity" | "value" | "root";
  readonly fields: Readonly<Record<string, GQLensFieldContract>>;
  readonly isAbstract?: boolean | undefined;
  readonly possibleTypes?: readonly string[] | undefined;
  readonly typeConditions?: readonly string[] | undefined;
}
```

字段结果直接表达 runtime 需要的判断：

- `result.kind`: `scalar` 或 `object`
- `result.cardinality`: `one` 或 `list`
- `result.typeName`: object 字段的 GraphQL 返回类型名
- `result.objectKind`: `entity` 或 `value`
- `result.isAbstract` / `result.possibleTypes`: interface / union 的 concrete type 范围

## 消费规则

Planner 使用 contract 判断字段是否返回对象、是否需要补 `id` / `__typename`、abstract list 是否需要 concrete type fragment。

Accessor runtime 使用 contract 生成字段 getter、relation node、value object node、`.ids` / `.refs` 和 `$on.<TypeCondition>` 分支。

GraphDataStore `writeGraphQLResult()` 使用 contract 判断响应字段应写入 entity field、root slot、relation slot、list identity，还是 value object embedded leaf。

Invalidation 使用 contract 将 selection target 映射到 root slot family，并在可以确定 concrete root entity 时同步标记 entity address family。

Mutation operation descriptor 携带同一份 contract，mutation response 按 mutation root field 写回 store。

## API 形态

public runtime API 只接收 `schema`：

```ts
store.writeGraphQLResult(result, { ttl, schema });
createQuerySession({ store, fetcher, schema, policy, ttl });
createLiveQuerySession({ store, subscriber, schema, policy, ttl });
applyInvalidations(store, invalidations, schema);
```

`ttl` 和 `schema` 使用 options object，避免 positional 参数在后续扩展中继续破坏签名。

## 边界

runtime 不根据响应值猜测 object kind、list kind 或 identity policy；无 schema contract 时只保留 schema-agnostic fallback，用于直接写入含 `__typename + id` 的普通实体对象。

schema 规则必须先进入 `gqlensSchema`，再被 planner、accessor、normalize、invalidation、mutation 读取。不能在某个 runtime 模块里临时补一套同义判断。

如果后续新增 connection、incremental delivery、field hint 或 identity 扩展，仍按同一顺序演进：

1. codegen 写入 `gqlensSchema`
2. runtime helper 只做直接读取和 predicate
3. 各模块按需消费 contract 字段
4. 测试覆盖 runtime 行为，而不是固定生成文件文本形态

## 命名

`GQLensSchemaContract` 表达的是 GQLens 内部执行契约，不是 GraphQL `GraphQLSchema`，也不是泛化配置容器。生成值命名为 `gqlensSchema`，因为用户在 generated accessor 中面对的是“当前 GQLens runtime schema”，而不是手写 contract 对象。

## 约束

- 不新增第二套 schema contract。
- 不新增 adapter 私有 schema 描述。
- 不新增 public identity policy 修补 contract。
- 不把 operation option、transport option 或 cache policy 塞进字段链。
- 不让 generated accessor 依赖额外文件入口。

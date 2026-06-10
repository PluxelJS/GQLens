import { applyInvalidations } from "./invalidation";
import { readGraphQLData, type Fetcher } from "./transport";
import { isEntityObject } from "./guards";
import type {
  GraphDataInvalidation,
  GQLensSchemaContract,
  MutationOptions,
  MutationDefinition,
  GraphDataStore,
} from "./types";

export interface MutationRunnerConfig<TInput extends Record<string, unknown>, TData> {
  readonly store: GraphDataStore;
  readonly definition: MutationDefinition<TInput, TData>;
  readonly fetcher: Fetcher;
  readonly schema?: GQLensSchemaContract | undefined;
  invalidate?(invalidations: readonly GraphDataInvalidation[], schema?: GQLensSchemaContract): void;
}

export function createMutationRunner<TInput extends Record<string, unknown>, TData>(
  config: MutationRunnerConfig<TInput, TData>,
): (input: TInput, options?: MutationOptions) => Promise<TData> {
  const mutate = mutationFunction(config.definition, config.fetcher);
  const schema = config.schema ?? mutationSchema(config.definition);
  const rootField = mutationRootField(config.definition);
  const invalidate =
    config.invalidate ??
    ((invalidations: readonly GraphDataInvalidation[]) => {
      applyInvalidations(config.store, invalidations, schema);
    });

  return async (input, options = {}): Promise<TData> => {
    const invalidates = options.invalidates ?? [];
    const transaction = options.optimistic
      ? config.store.transaction((store) => {
          options.optimistic?.(store);
        })
      : undefined;

    try {
      const data = await mutate(input);
      if (invalidates.length > 0) {
        invalidate(invalidates, schema);
      }
      normalizeMutationResult(config.store, data, schema, rootField);
      return data;
    } catch (error) {
      transaction?.rollback();
      throw error;
    }
  };
}

function mutationSchema<TInput extends Record<string, unknown>, TData>(
  definition: MutationDefinition<TInput, TData>,
): GQLensSchemaContract | undefined {
  return typeof definition === "function" ? undefined : definition.schema;
}

function mutationRootField<TInput extends Record<string, unknown>, TData>(
  definition: MutationDefinition<TInput, TData>,
): string | undefined {
  return typeof definition === "function" ? undefined : definition.operationName;
}

function mutationFunction<TInput extends Record<string, unknown>, TData>(
  definition: MutationDefinition<TInput, TData>,
  fetcher: Fetcher,
): (input: TInput) => Promise<TData> {
  if (typeof definition === "function") {
    return definition;
  }

  return async (input: TInput): Promise<TData> => {
    const response = await fetcher({
      query: definition.query,
      variables: definition.variables(input),
      operationName: definition.operationName,
      selections: [],
    });
    const data = readGraphQLData(response);
    return (data[definition.operationName] ?? data) as TData;
  };
}

function normalizeMutationResult(
  store: GraphDataStore,
  data: unknown,
  schema: GQLensSchemaContract | undefined,
  rootField: string | undefined,
): void {
  if (rootField) {
    store.writeGraphQLResult({ [rootField]: data }, { schema });
    return;
  }
  if (isEntityObject(data)) {
    store.writeGraphQLResult({ mutation: data });
    return;
  }
  store.writeGraphQLResult((data ?? {}) as Record<string, unknown>, { schema });
}

import { applyInvalidations } from "./invalidation";
import { readGraphQLData, type Fetcher } from "./transport";
import { isEntityObject } from "./guards";
import type {
  CacheInvalidation,
  MutationOptions,
  MutationSource,
  NormalizedCache,
  PlannerMetadata,
} from "./types";

export interface MutationRunnerConfig<TInput extends Record<string, unknown>, TData> {
  readonly cache: NormalizedCache;
  readonly mutation: MutationSource<TInput, TData>;
  readonly fetcher: Fetcher;
  readonly metadata?: PlannerMetadata | undefined;
  invalidate?(invalidations: readonly CacheInvalidation[], metadata?: PlannerMetadata): void;
}

export function createMutationRunner<TInput extends Record<string, unknown>, TData>(
  config: MutationRunnerConfig<TInput, TData>,
): (input: TInput & MutationOptions) => Promise<TData> {
  const mutate = mutationFunction(config.mutation, config.fetcher);
  const metadata = config.metadata ?? mutationMetadata(config.mutation);
  const invalidate =
    config.invalidate ??
    ((invalidations: readonly CacheInvalidation[]) => {
      applyInvalidations(config.cache, invalidations, metadata);
    });

  return async (input): Promise<TData> => {
    const invalidates = input.invalidates ?? [];
    const transaction = input.optimistic
      ? config.cache.transaction((cache) => {
          input.optimistic?.(cache);
        })
      : undefined;

    try {
      const data = await mutate(input);
      if (invalidates.length > 0) {
        invalidate(invalidates, metadata);
      }
      normalizeMutationResult(config.cache, data, metadata);
      return data;
    } catch (error) {
      transaction?.rollback();
      throw error;
    }
  };
}

function mutationMetadata<TInput extends Record<string, unknown>, TData>(
  mutation: MutationSource<TInput, TData>,
): PlannerMetadata | undefined {
  return typeof mutation === "function" ? undefined : mutation.metadata;
}

function mutationFunction<TInput extends Record<string, unknown>, TData>(
  mutation: MutationSource<TInput, TData>,
  fetcher: Fetcher,
): (input: TInput) => Promise<TData> {
  if (typeof mutation === "function") {
    return mutation;
  }

  return async (input: TInput): Promise<TData> => {
    const response = await fetcher({
      query: mutation.query,
      variables: mutation.variables(input),
      operationName: mutation.operationName,
      selections: [],
    });
    const data = readGraphQLData(response);
    return (data[mutation.operationName] ?? data) as TData;
  };
}

function normalizeMutationResult(
  cache: NormalizedCache,
  data: unknown,
  metadata: PlannerMetadata | undefined,
): void {
  if (isEntityObject(data)) {
    cache.normalize({ mutation: data }, 0, mutationResultMetadata(data, metadata));
    return;
  }
  cache.normalize((data ?? {}) as Record<string, unknown>, 0, metadata);
}

function mutationResultMetadata(
  data: Record<string, unknown>,
  metadata: PlannerMetadata | undefined,
): PlannerMetadata | undefined {
  if (!metadata || typeof data["__typename"] !== "string") {
    return metadata;
  }
  return {
    ...metadata,
    roots: {
      ...metadata.roots,
      mutation: {
        returnsEntity: true,
        graphQLType: data["__typename"],
        targetObjectKind: "entity",
      },
    },
  };
}

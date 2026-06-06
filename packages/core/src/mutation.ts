import { applyInvalidations, isInvalidationSpec } from "./invalidation";
import type { Fetcher } from "./transport";
import type {
  InvalidationInput,
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
  invalidate?(invalidations: readonly InvalidationInput[]): void;
}

export function createMutationRunner<TInput extends Record<string, unknown>, TData>(
  config: MutationRunnerConfig<TInput, TData>,
): (input: TInput & MutationOptions) => Promise<TData> {
  const mutate = mutationFunction(config.mutation, config.fetcher);
  const invalidate =
    config.invalidate ??
    ((invalidations: readonly InvalidationInput[]) => {
      applyInvalidations(config.cache, invalidations, config.metadata);
    });

  return async (input): Promise<TData> => {
    const snapshots = input.optimistic
      ? snapshotFields(config.cache, input.invalidates ?? [])
      : new Map<string, Record<string, unknown>>();
    input.optimistic?.(config.cache);

    try {
      const data = await mutate(input);
      if (input.invalidates && input.invalidates.length > 0) {
        invalidate(input.invalidates);
      }
      normalizeMutationResult(config.cache, data);
      return data;
    } catch (error) {
      rollback(config.cache, input.invalidates ?? [], snapshots, config.metadata);
      throw error;
    }
  };
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

function readGraphQLData(data: unknown): Record<string, unknown> {
  if (isRecord(data) && isRecord(data["data"])) {
    return data["data"];
  }
  return (data ?? {}) as Record<string, unknown>;
}

function normalizeMutationResult(cache: NormalizedCache, data: unknown): void {
  if (isEntityObject(data)) {
    cache.normalize({ mutation: data });
    return;
  }
  cache.normalize((data ?? {}) as Record<string, unknown>);
}

function isEntityObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "__typename" in value && "id" in value;
}

function snapshotFields(
  cache: NormalizedCache,
  specs: readonly InvalidationInput[],
): Map<string, Record<string, unknown>> {
  const snapshots = new Map<string, Record<string, unknown>>();
  for (const spec of specs) {
    if (!isInvalidationSpec(spec)) {
      continue;
    }
    if (!spec.keys || spec.keys.length === 0) {
      continue;
    }
    const ref = cache.entity(spec.type, spec.id);
    const fields: Record<string, unknown> = {};
    for (const key of spec.keys) {
      fields[key] = cache.field(ref, key).sig();
    }
    snapshots.set(`${spec.type}:${spec.id}`, fields);
  }
  return snapshots;
}

function rollback(
  cache: NormalizedCache,
  specs: readonly InvalidationInput[],
  snapshots: ReadonlyMap<string, Record<string, unknown>>,
  metadata: PlannerMetadata | undefined,
): void {
  for (const spec of specs) {
    if (!isInvalidationSpec(spec)) {
      applyInvalidations(cache, [spec], metadata);
      continue;
    }
    const ref = cache.entity(spec.type, spec.id);
    const snapshot = snapshots.get(`${spec.type}:${spec.id}`);
    if (snapshot && spec.keys) {
      for (const key of spec.keys) {
        cache.field(ref, key).sig(snapshot[key]);
      }
    } else {
      cache.invalidate(ref, spec.keys);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

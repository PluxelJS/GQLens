import { selectionKey } from "../keys";
import { plan } from "../planner";
import { SieveCache } from "../sieve-cache";
import type { GraphQLOperation, PlannerMetadata, SelectionPath } from "../types";

const maxPlanCacheEntries = 128;

export function createPlanCache(): SieveCache<string, GraphQLOperation> {
  return new SieveCache<string, GraphQLOperation>(maxPlanCacheEntries);
}

export function operationKey(operation: {
  readonly query: string;
  readonly variables: unknown;
}): string {
  return `${operation.query}\n${JSON.stringify(operation.variables)}`;
}

export function planCached(
  cache: SieveCache<string, GraphQLOperation>,
  paths: readonly SelectionPath[],
  operationType: string,
  metadata: PlannerMetadata | undefined,
): GraphQLOperation {
  const key = planCacheKey(paths, operationType);
  const cached = cache.get(key);
  if (cached) {
    return cloneOperation(cached);
  }
  const operation = plan(paths, operationType, metadata);
  cache.set(key, operation);
  return cloneOperation(operation);
}

function cloneOperation(operation: GraphQLOperation): GraphQLOperation {
  return { ...operation, variables: { ...operation.variables } };
}

function planCacheKey(paths: readonly SelectionPath[], operationType: string): string {
  return `${operationType}\n${paths.map(selectionKey).toSorted().join("\n")}`;
}

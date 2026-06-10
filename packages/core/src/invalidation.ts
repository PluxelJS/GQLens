import type { GQLensSchemaContract, GraphDataInvalidation, GraphDataStore } from "./types";

export function applyInvalidations(
  store: GraphDataStore,
  invalidations: readonly GraphDataInvalidation[],
  schema?: GQLensSchemaContract,
): void {
  store.invalidate(
    invalidations.map((invalidation) =>
      invalidation.kind === "selection" && !invalidation.schema
        ? { ...invalidation, schema }
        : invalidation,
    ),
  );
}

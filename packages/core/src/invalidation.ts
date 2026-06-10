import type { GraphDataInvalidation, GraphDataStore, PlannerMetadata } from "./types";

export function applyInvalidations(
  store: GraphDataStore,
  invalidations: readonly GraphDataInvalidation[],
  metadata?: PlannerMetadata,
): void {
  store.invalidate(
    invalidations.map((invalidation) =>
      invalidation.kind === "selection" && !invalidation.metadata
        ? { ...invalidation, metadata }
        : invalidation,
    ),
  );
}

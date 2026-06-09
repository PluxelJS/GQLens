import type { CacheInvalidation, NormalizedCache, PlannerMetadata } from "./types";

export function applyInvalidations(
  cache: NormalizedCache,
  invalidations: readonly CacheInvalidation[],
  metadata?: PlannerMetadata,
): void {
  cache.invalidate(
    invalidations.map((invalidation) =>
      invalidation.kind === "selection" && !invalidation.metadata
        ? { ...invalidation, metadata }
        : invalidation,
    ),
  );
}

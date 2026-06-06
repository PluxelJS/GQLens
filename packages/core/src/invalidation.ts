import { slotKey, stepKey } from "./keys";
import type {
  InvalidationInput,
  InvalidationSpec,
  InvalidationTarget,
  NormalizedCache,
  PlannerMetadata,
  SelectionPath,
  SelectionStep,
} from "./types";

export function applyInvalidations(
  cache: NormalizedCache,
  invalidations: readonly InvalidationInput[],
  metadata?: PlannerMetadata,
): void {
  for (const invalidation of invalidations) {
    if (isInvalidationSpec(invalidation)) {
      cache.invalidate(cache.entity(invalidation.type, invalidation.id), invalidation.keys);
      continue;
    }
    invalidateTarget(cache, invalidation, metadata);
  }
}

export function isInvalidationSpec(value: InvalidationInput): value is InvalidationSpec {
  return "type" in value && "id" in value;
}

function invalidateTarget(
  cache: NormalizedCache,
  target: InvalidationTarget,
  metadata: PlannerMetadata | undefined,
): void {
  const path =
    target.kind === "selection" ? target.path : { root: target.root, steps: target.steps };
  invalidatePathSlots(cache, path);
  invalidateConcreteRootEntityField(cache, path, metadata);
}

function invalidatePathSlots(cache: NormalizedCache, path: SelectionPath): void {
  const relationSteps = isListIdentityStep(path.steps.at(-1))
    ? path.steps.slice(0, -1)
    : path.steps;
  cache.invalidateSlot(slotKey(path.root, relationSteps));
  cache.invalidateSlot(slotKey(path.root, relationSteps, "ids"));
  cache.invalidateSlot(slotKey(path.root, relationSteps, "refs"));
}

function invalidateConcreteRootEntityField(
  cache: NormalizedCache,
  path: SelectionPath,
  metadata: PlannerMetadata | undefined,
): void {
  const [rootStep, ...rest] = path.steps;
  const leaf = rest.at(-1);
  const id = rootStep?.args?.["id"];
  const rootMeta = rootStep ? metadata?.roots?.[rootStep.field] : undefined;
  if (
    !rootStep ||
    rest.length !== 1 ||
    !leaf ||
    isListIdentityStep(leaf) ||
    id === undefined ||
    !rootMeta?.graphQLType ||
    rootMeta.isAbstract
  ) {
    return;
  }
  cache.invalidate(cache.entity(rootMeta.graphQLType, String(id)), [stepKey(leaf)]);
}

function isListIdentityStep(step: SelectionStep | undefined): boolean {
  return step?.field === "ids" || step?.field === "refs";
}

import type {
  CacheAddress,
  EntityRef,
  NormalizedCache,
  PlannedSelectionPath,
  PlannedSelectionStep,
  PlannerMetadata,
  SelectionStep,
} from "../types";
import { isEntityObject, isRecord } from "../guards";
import { readGraphQLData } from "../transport";
import {
  type CacheSlotSuffix,
  fieldStepForPath,
  isListIdentityStep,
  ownerFieldSteps,
  rootSlotKey,
} from "./address";
import { expiresAt } from "./store";

interface SlotSyncContext {
  readonly cache: NormalizedCache;
  readonly expires: number;
  readonly metadata: PlannerMetadata | undefined;
  readonly seen: Set<string>;
}

export function writeOperationResult(
  cache: NormalizedCache,
  data: unknown,
  selections: readonly PlannedSelectionPath[],
  ttl: number,
  metadata: PlannerMetadata | undefined,
): void {
  const result = readGraphQLData(data);
  cache.normalize(result, ttl, metadata);
  syncSlots(cache, result, selections, ttl, metadata);
}

function syncSlots(
  cache: NormalizedCache,
  data: Record<string, unknown>,
  paths: readonly PlannedSelectionPath[],
  ttl: number,
  metadata: PlannerMetadata | undefined,
): void {
  const expires = expiresAt(ttl);
  const context: SlotSyncContext = {
    cache,
    expires,
    metadata,
    seen: new Set<string>(),
  };

  for (const path of paths) {
    syncPathSlots(context, data, path);
  }
}

function syncPathSlots(
  context: SlotSyncContext,
  data: Record<string, unknown>,
  path: PlannedSelectionPath,
): void {
  const { cache, expires, metadata, seen } = context;
  let current: unknown = data;
  const originalSteps: PlannedSelectionStep[] = [];
  let ownerRef: EntityRef | undefined;
  let ownerFieldStartIndex = 0;

  for (const [index, step] of path.steps.entries()) {
    originalSteps.push(step);
    if (isListIdentityStep(step)) {
      continue;
    }
    if (!isRecord(current)) {
      return;
    }

    if (step.typeCondition) {
      if (!matchesTypeCondition(current, step.typeCondition, metadata)) {
        return;
      }
      continue;
    }

    const parentRef = isEntityObject(current) ? entityFrom(cache, current) : undefined;
    current = current[step.responseKey ?? step.field];
    if (isEntityObject(current)) {
      ownerRef = entityFrom(cache, current);
      ownerFieldStartIndex = index + 1;
    }

    const steps = originalSteps.map(({ field, args }) => ({ field, args }));
    if (index === path.steps.length - 1 && isLeafValue(current)) {
      writeLeafSlot(context, path.root, steps, current);
      writeOwnerLeafField(context, ownerRef, ownerFieldSteps(steps, ownerFieldStartIndex), current);
      continue;
    }

    const nextStep = path.steps[index + 1];
    const normalized = toSlotValue(cache, current, isListIdentityStep(nextStep));
    if (normalized === undefined) {
      continue;
    }

    const address = rootAddress(path.root, steps);
    const key = rootSlotKey(path.root, steps);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    writeCacheAddress(cache, address, normalized, expires);

    if (Array.isArray(normalized)) {
      const identityStep = path.steps[index + 1];
      if (identityStep?.field === "refs") {
        writeCacheAddress(cache, rootAddress(path.root, steps, "refs"), normalized, expires);
        clearCacheAddress(cache, rootAddress(path.root, steps, "ids"));
      } else {
        writeCacheAddress(
          cache,
          rootAddress(path.root, steps, "ids"),
          normalized.map((ref) => ref.id),
          expires,
        );
        clearCacheAddress(cache, rootAddress(path.root, steps, "refs"));
      }
      writeRelationSlot(context, parentRef, step, normalized);
      writeOwnerRelationSlot(context, ownerRef, ownerFieldStartIndex, steps, normalized);
      if (identityStep?.field === "refs") {
        writeRelationSlot(context, parentRef, step, normalized, "refs");
        writeOwnerRelationSlot(context, ownerRef, ownerFieldStartIndex, steps, normalized, "refs");
        clearRelationSlotSuffix(cache, parentRef, step, "ids");
      } else {
        const ids = normalized.map((ref) => ref.id);
        writeRelationSlot(context, parentRef, step, ids, "ids");
        writeOwnerRelationSlot(context, ownerRef, ownerFieldStartIndex, steps, ids, "ids");
        clearRelationSlotSuffix(cache, parentRef, step, "refs");
      }
    } else if (normalized === null) {
      clearCacheAddress(cache, rootAddress(path.root, steps, "ids"));
      clearCacheAddress(cache, rootAddress(path.root, steps, "refs"));
      writeRelationSlot(context, parentRef, step, null);
      writeOwnerRelationSlot(context, ownerRef, ownerFieldStartIndex, steps, null);
      if (index < path.steps.length - 1) {
        clearOwnerLeafField(context, ownerRef, ownerFieldSteps(path.steps, ownerFieldStartIndex));
      }
    } else if (normalized && "type" in normalized && parentRef) {
      clearCacheAddress(cache, rootAddress(path.root, steps, "ids"));
      clearCacheAddress(cache, rootAddress(path.root, steps, "refs"));
      writeRelationSlot(context, parentRef, step, normalized);
      writeOwnerRelationSlot(context, ownerRef, ownerFieldStartIndex, steps, normalized);
    } else {
      clearCacheAddress(cache, rootAddress(path.root, steps, "ids"));
      clearCacheAddress(cache, rootAddress(path.root, steps, "refs"));
      clearRelationSlotSuffix(cache, parentRef, step, "ids");
      clearRelationSlotSuffix(cache, parentRef, step, "refs");
    }
  }
}

function writeOwnerRelationSlot(
  context: SlotSyncContext,
  ownerRef: EntityRef | undefined,
  ownerFieldStartIndex: number,
  steps: readonly SelectionStep[],
  value: EntityRef | readonly EntityRef[] | readonly string[] | null,
  suffix?: CacheSlotSuffix,
): void {
  if (!ownerRef) {
    return;
  }
  const step = fieldStepForPath(ownerFieldSteps(steps, ownerFieldStartIndex));
  if (!step) {
    return;
  }
  writeRelationSlot(context, ownerRef, step, value, suffix);
}

function writeLeafSlot(
  context: SlotSyncContext,
  root: string,
  steps: readonly SelectionStep[],
  value: string | number | boolean | null,
): void {
  const address = rootAddress(root, steps);
  writeCacheAddress(context.cache, address, value, context.expires);
  clearCacheAddress(context.cache, rootAddress(root, steps, "ids"));
  clearCacheAddress(context.cache, rootAddress(root, steps, "refs"));
}

function writeOwnerLeafField(
  context: SlotSyncContext,
  ownerRef: EntityRef | undefined,
  fieldSteps: readonly SelectionStep[],
  value: string | number | boolean | null,
): void {
  if (!ownerRef || fieldSteps.length === 0) {
    return;
  }
  writeCacheAddress(
    context.cache,
    { owner: { kind: "entity", ref: ownerRef }, path: fieldSteps },
    value,
    context.expires,
  );
}

function clearOwnerLeafField(
  context: SlotSyncContext,
  ownerRef: EntityRef | undefined,
  fieldSteps: readonly SelectionStep[],
): void {
  if (!ownerRef || fieldSteps.length === 0) {
    return;
  }
  clearCacheAddress(context.cache, { owner: { kind: "entity", ref: ownerRef }, path: fieldSteps });
}

function writeRelationSlot(
  context: SlotSyncContext,
  ref: EntityRef | undefined,
  step: SelectionStep,
  value: EntityRef | readonly EntityRef[] | readonly string[] | null,
  suffix?: CacheSlotSuffix,
): void {
  if (!ref) {
    return;
  }
  writeCacheAddress(context.cache, relationCacheAddress(ref, step, suffix), value, context.expires);
}

function clearRelationSlotSuffix(
  cache: NormalizedCache,
  ref: EntityRef | undefined,
  step: SelectionStep,
  suffix: CacheSlotSuffix,
): void {
  if (ref) {
    clearCacheAddress(cache, relationCacheAddress(ref, step, suffix));
  }
}

function writeCacheAddress<T>(
  cache: NormalizedCache,
  address: CacheAddress,
  value: T,
  expires: number,
): void {
  const entry = cache.entry<T>(address);
  entry.sig(value);
  entry.expires = expires;
}

function clearCacheAddress(cache: NormalizedCache, address: CacheAddress): void {
  const entry = cache.peek(address);
  if (!entry) {
    return;
  }
  entry.sig(undefined);
  entry.expires = 0;
}

function rootAddress(
  root: string,
  steps: readonly SelectionStep[],
  facet?: "ids" | "refs",
): CacheAddress {
  return { owner: { kind: "root", root }, path: steps, facet };
}

function relationCacheAddress(
  ref: EntityRef,
  step: SelectionStep,
  suffix?: CacheSlotSuffix,
): CacheAddress {
  return { owner: { kind: "entity", ref }, path: [step], facet: suffix ?? "link" };
}

function toSlotValue(
  cache: NormalizedCache,
  value: unknown,
  expectsListIdentity: boolean,
): EntityRef | readonly EntityRef[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    if (!expectsListIdentity && !value.some(isEntityObject)) {
      return undefined;
    }
    return value.flatMap((item) => (isEntityObject(item) ? [entityFrom(cache, item)] : []));
  }
  if (isEntityObject(value)) {
    return entityFrom(cache, value);
  }
  return undefined;
}

function entityFrom(cache: NormalizedCache, value: Record<string, unknown>): EntityRef {
  return cache.entity(String(value["__typename"]), String(value["id"]));
}

function isLeafValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function matchesTypeCondition(
  value: Record<string, unknown>,
  typeCondition: string,
  metadata: PlannerMetadata | undefined,
): boolean {
  const typename = value["__typename"];
  if (typename === typeCondition) {
    return true;
  }
  if (typeof typename !== "string") {
    return false;
  }
  return (
    metadata?.types?.[typeCondition]?.["__typename"]?.possibleTypes?.includes(typename) ?? false
  );
}

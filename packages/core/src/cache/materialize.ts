import type {
  GraphDataAddress,
  EntityRef,
  GQLensSchemaContract,
  GraphDataRuntimeStore,
  PlannedSelectionPath,
  PlannedSelectionStep,
  SelectionStep,
} from "../types";
import { isEntityObject, isRecord } from "../guards";
import { readGraphQLData } from "../transport";
import {
  type GraphDataSlotSuffix,
  fieldStepForPath,
  isListIdentityStep,
  ownerFieldSteps,
  rootSlotKey,
} from "./address";
import { expiresAt } from "./store";

interface SlotSyncContext {
  readonly store: GraphDataRuntimeStore;
  readonly expires: number;
  readonly schema: GQLensSchemaContract | undefined;
  readonly seen: Set<string>;
}

export function writeOperationResult(
  store: GraphDataRuntimeStore,
  data: unknown,
  selections: readonly PlannedSelectionPath[],
  ttl: number,
  schema: GQLensSchemaContract | undefined,
): void {
  const result = readGraphQLData(data);
  store.writeGraphQLResult(result, { ttl, schema });
  syncSlots(store, result, selections, ttl, schema);
}

function syncSlots(
  store: GraphDataRuntimeStore,
  data: Record<string, unknown>,
  paths: readonly PlannedSelectionPath[],
  ttl: number,
  schema: GQLensSchemaContract | undefined,
): void {
  const expires = expiresAt(ttl);
  const context: SlotSyncContext = {
    store,
    expires,
    schema,
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
  const { store, expires, schema, seen } = context;
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
      if (!matchesTypeCondition(current, step.typeCondition, schema)) {
        return;
      }
      continue;
    }

    const parentRef = isEntityObject(current) ? entityFrom(store, current) : undefined;
    current = current[step.responseKey ?? step.field];
    if (isEntityObject(current)) {
      ownerRef = entityFrom(store, current);
      ownerFieldStartIndex = index + 1;
    }

    const steps = originalSteps.map(({ field, args }) => ({ field, args }));
    if (index === path.steps.length - 1 && isLeafValue(current)) {
      writeLeafSlot(context, path.root, steps, current);
      writeOwnerLeafField(context, ownerRef, ownerFieldSteps(steps, ownerFieldStartIndex), current);
      continue;
    }

    const nextStep = path.steps[index + 1];
    const normalized = toSlotValue(store, current, isListIdentityStep(nextStep));
    if (normalized === undefined) {
      continue;
    }

    const address = rootAddress(path.root, steps);
    const key = rootSlotKey(path.root, steps);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    writeGraphDataAddress(store, address, normalized, expires);

    if (Array.isArray(normalized)) {
      const identityStep = path.steps[index + 1];
      if (identityStep?.field === "refs") {
        writeGraphDataAddress(store, rootAddress(path.root, steps, "refs"), normalized, expires);
        clearGraphDataAddress(store, rootAddress(path.root, steps, "ids"));
      } else {
        writeGraphDataAddress(
          store,
          rootAddress(path.root, steps, "ids"),
          normalized.map((ref) => ref.id),
          expires,
        );
        clearGraphDataAddress(store, rootAddress(path.root, steps, "refs"));
      }
      writeRelationSlot(context, parentRef, step, normalized);
      writeOwnerRelationSlot(context, ownerRef, ownerFieldStartIndex, steps, normalized);
      if (identityStep?.field === "refs") {
        writeRelationSlot(context, parentRef, step, normalized, "refs");
        writeOwnerRelationSlot(context, ownerRef, ownerFieldStartIndex, steps, normalized, "refs");
        clearRelationSlotSuffix(store, parentRef, step, "ids");
      } else {
        const ids = normalized.map((ref) => ref.id);
        writeRelationSlot(context, parentRef, step, ids, "ids");
        writeOwnerRelationSlot(context, ownerRef, ownerFieldStartIndex, steps, ids, "ids");
        clearRelationSlotSuffix(store, parentRef, step, "refs");
      }
    } else if (normalized === null) {
      clearGraphDataAddress(store, rootAddress(path.root, steps, "ids"));
      clearGraphDataAddress(store, rootAddress(path.root, steps, "refs"));
      writeRelationSlot(context, parentRef, step, null);
      writeOwnerRelationSlot(context, ownerRef, ownerFieldStartIndex, steps, null);
      if (index < path.steps.length - 1) {
        clearOwnerLeafField(context, ownerRef, ownerFieldSteps(path.steps, ownerFieldStartIndex));
      }
    } else if (normalized && "type" in normalized && parentRef) {
      clearGraphDataAddress(store, rootAddress(path.root, steps, "ids"));
      clearGraphDataAddress(store, rootAddress(path.root, steps, "refs"));
      writeRelationSlot(context, parentRef, step, normalized);
      writeOwnerRelationSlot(context, ownerRef, ownerFieldStartIndex, steps, normalized);
    } else {
      clearGraphDataAddress(store, rootAddress(path.root, steps, "ids"));
      clearGraphDataAddress(store, rootAddress(path.root, steps, "refs"));
      clearRelationSlotSuffix(store, parentRef, step, "ids");
      clearRelationSlotSuffix(store, parentRef, step, "refs");
    }
  }
}

function writeOwnerRelationSlot(
  context: SlotSyncContext,
  ownerRef: EntityRef | undefined,
  ownerFieldStartIndex: number,
  steps: readonly SelectionStep[],
  value: EntityRef | readonly EntityRef[] | readonly string[] | null,
  suffix?: GraphDataSlotSuffix,
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
  writeGraphDataAddress(context.store, address, value, context.expires);
  clearGraphDataAddress(context.store, rootAddress(root, steps, "ids"));
  clearGraphDataAddress(context.store, rootAddress(root, steps, "refs"));
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
  writeGraphDataAddress(
    context.store,
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
  clearGraphDataAddress(context.store, {
    owner: { kind: "entity", ref: ownerRef },
    path: fieldSteps,
  });
}

function writeRelationSlot(
  context: SlotSyncContext,
  ref: EntityRef | undefined,
  step: SelectionStep,
  value: EntityRef | readonly EntityRef[] | readonly string[] | null,
  suffix?: GraphDataSlotSuffix,
): void {
  if (!ref) {
    return;
  }
  writeGraphDataAddress(
    context.store,
    relationGraphDataAddress(ref, step, suffix),
    value,
    context.expires,
  );
}

function clearRelationSlotSuffix(
  store: GraphDataRuntimeStore,
  ref: EntityRef | undefined,
  step: SelectionStep,
  suffix: GraphDataSlotSuffix,
): void {
  if (ref) {
    clearGraphDataAddress(store, relationGraphDataAddress(ref, step, suffix));
  }
}

function writeGraphDataAddress<T>(
  store: GraphDataRuntimeStore,
  address: GraphDataAddress,
  value: T,
  expires: number,
): void {
  const entry = store.entry<T>(address);
  entry.sig(value);
  entry.expires = expires;
}

function clearGraphDataAddress(store: GraphDataRuntimeStore, address: GraphDataAddress): void {
  const entry = store.peek(address);
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
): GraphDataAddress {
  return { owner: { kind: "root", root }, path: steps, facet };
}

function relationGraphDataAddress(
  ref: EntityRef,
  step: SelectionStep,
  suffix?: GraphDataSlotSuffix,
): GraphDataAddress {
  return { owner: { kind: "entity", ref }, path: [step], facet: suffix ?? "link" };
}

function toSlotValue(
  store: GraphDataRuntimeStore,
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
    return value.flatMap((item) => (isEntityObject(item) ? [entityFrom(store, item)] : []));
  }
  if (isEntityObject(value)) {
    return entityFrom(store, value);
  }
  return undefined;
}

function entityFrom(store: GraphDataRuntimeStore, value: Record<string, unknown>): EntityRef {
  return store.entity(String(value["__typename"]), String(value["id"]));
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
  schema: GQLensSchemaContract | undefined,
): boolean {
  const typename = value["__typename"];
  if (typename === typeCondition) {
    return true;
  }
  if (typeof typename !== "string") {
    return false;
  }
  return schema?.objects[typeCondition]?.possibleTypes?.includes(typename) ?? false;
}

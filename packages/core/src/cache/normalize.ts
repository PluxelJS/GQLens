import type {
  EntityRef,
  GraphQLResult,
  PlannerFieldMetadata,
  PlannerMetadata,
  SelectionStep,
} from "../types";
import { isEntityObject, isRecord } from "../guards";
import {
  cacheFieldKey,
  entityFieldKey,
  entityRelationKey,
  fieldStepForPath,
  suffixedSlotKey,
} from "./address";
import type { EntityRefStore } from "./entity";
import { clearSlotIdentities, type CacheStore, type FieldEntry, writeEntry } from "./store";

interface NormalizeContext {
  readonly store: CacheStore;
  readonly entityRefs: EntityRefStore;
  readonly expires: number;
}

interface MetadataNormalizeContext extends NormalizeContext {
  readonly metadata: PlannerMetadata;
}

interface NormalizeTarget {
  readonly slotKey: string;
  readonly ownerRef?: EntityRef | undefined;
  readonly fieldSteps: readonly SelectionStep[];
}

export function normalizeGraphQLResult(
  data: GraphQLResult,
  store: CacheStore,
  entityRefs: EntityRefStore,
  expires: number,
  metadata: PlannerMetadata | undefined,
): void {
  const context = { store, entityRefs, expires };
  for (const [rootField, value] of Object.entries(data)) {
    const slotBase = `Query.${rootField}`;
    const meta = metadata?.roots?.[rootField];
    if (meta) {
      normalizeValueWithMeta(value, meta, { ...context, metadata }, rootTarget(slotBase));
      continue;
    }
    normalizeValue(value, context, slotBase);
  }
}

function normalizeValueWithMeta(
  value: unknown,
  meta: PlannerFieldMetadata,
  context: MetadataNormalizeContext,
  target: NormalizeTarget,
): EntityRef | readonly EntityRef[] | null | undefined {
  const { store, expires } = context;
  const { slotKey, ownerRef, fieldSteps } = target;
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    writeEntry(store.slots, slotKey, null, expires);
    clearSlotIdentities(store.slots, slotKey);
    if (ownerRef && fieldSteps.length > 0) {
      clearEntityFieldPrefix(store.fields, ownerRef, cacheFieldKey(fieldSteps));
    }
    return null;
  }

  if (meta.returnsList) {
    if (!Array.isArray(value)) {
      writeEntry(store.slots, slotKey, value, expires);
      clearSlotIdentities(store.slots, slotKey);
      return undefined;
    }

    if (!meta.graphQLType) {
      writeLeafValue(value, context, target);
      return undefined;
    }

    const typeName = meta.graphQLType;
    if (objectKind(meta) === "value") {
      writeEntry(store.slots, slotKey, value, expires);
      clearSlotIdentities(store.slots, slotKey);
      return undefined;
    }

    const refs = value.flatMap((item) =>
      isEntityObject(item) ? [normalizeEntityWithMeta(item, context, typeName)] : [],
    );
    writeListRelation(store, slotKey, refs, expires);
    if (ownerRef && fieldSteps.length > 0) {
      const relationStep = fieldStepForPath(fieldSteps);
      if (relationStep) {
        writeOwnerListRelation(store, ownerRef, relationStep, refs, expires);
      }
    }
    return refs;
  }

  if (!meta.graphQLType) {
    writeLeafValue(value, context, target);
    return undefined;
  }

  if (objectKind(meta) === "value") {
    if (!isRecord(value)) {
      writeLeafValue(value, context, target);
      return undefined;
    }
    normalizeValueObjectWithMeta(value, context, meta.graphQLType, target);
    return undefined;
  }

  if (isEntityObject(value)) {
    const ref = normalizeEntityWithMeta(value, context, meta.graphQLType);
    writeEntry(store.slots, slotKey, ref, expires);
    clearSlotIdentities(store.slots, slotKey);
    if (ownerRef && fieldSteps.length > 0) {
      const relationStep = fieldStepForPath(fieldSteps);
      if (relationStep) {
        writeEntry(store.slots, entityRelationKey(ownerRef, relationStep), ref, expires);
      }
    }
    return ref;
  }

  return normalizeValue(value, context, slotKey);
}

function normalizeEntityWithMeta(
  entity: Record<string, unknown>,
  context: MetadataNormalizeContext,
  fallbackType: string,
): EntityRef {
  const typeName = typeof entity["__typename"] === "string" ? entity["__typename"] : fallbackType;
  const ref = context.entityRefs.entity(typeName, String(entity["id"]));
  const typeFields =
    context.metadata.types?.[typeName] ?? context.metadata.types?.[fallbackType] ?? {};

  for (const [key, value] of Object.entries(entity)) {
    const step: SelectionStep = { field: key };
    const meta = typeFields[key];
    if (meta) {
      normalizeValueWithMeta(
        value,
        meta,
        context,
        ownerTarget(entityRelationKey(ref, step), ref, [step]),
      );
      continue;
    }

    if (isFieldValue(value)) {
      writeEntry(context.store.fields, entityFieldKey(ref, key), value, context.expires);
      continue;
    }

    normalizeValue(value, context, entityRelationKey(ref, step));
  }

  return ref;
}

function normalizeValueObjectWithMeta(
  value: Record<string, unknown>,
  context: MetadataNormalizeContext,
  typeName: string,
  target: NormalizeTarget,
): void {
  const typeFields = context.metadata.types?.[typeName] ?? {};
  for (const [key, item] of Object.entries(value)) {
    const step: SelectionStep = { field: key };
    const nextSteps = [...target.fieldSteps, step];
    const meta = typeFields[key];
    const nextTarget = ownerTarget(`${target.slotKey}.${key}`, target.ownerRef, nextSteps);
    if (meta) {
      normalizeValueWithMeta(item, meta, context, nextTarget);
      continue;
    }
    writeLeafValue(item, context, nextTarget);
  }
}

function writeLeafValue(value: unknown, context: NormalizeContext, target: NormalizeTarget): void {
  if (target.ownerRef && target.fieldSteps.length > 0) {
    writeEntry(
      context.store.fields,
      entityFieldKey(target.ownerRef, cacheFieldKey(target.fieldSteps)),
      value,
      context.expires,
    );
    return;
  }
  writeEntry(context.store.slots, target.slotKey, value, context.expires);
  clearSlotIdentities(context.store.slots, target.slotKey);
}

function normalizeValue(
  value: unknown,
  context: NormalizeContext,
  slotKey: string,
): EntityRef | readonly EntityRef[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    writeEntry(context.store.slots, slotKey, null, context.expires);
    clearSlotIdentities(context.store.slots, slotKey);
    return null;
  }

  if (Array.isArray(value)) {
    if (!value.some(isEntityObject)) {
      writeEntry(context.store.slots, slotKey, value, context.expires);
      clearSlotIdentities(context.store.slots, slotKey);
      return undefined;
    }

    const refs = value.flatMap((item) =>
      isEntityObject(item) ? [normalizeEntity(item, context)] : [],
    );
    writeListRelation(context.store, slotKey, refs, context.expires);
    return refs;
  }

  if (isEntityObject(value)) {
    const ref = normalizeEntity(value, context);
    writeEntry(context.store.slots, slotKey, ref, context.expires);
    clearSlotIdentities(context.store.slots, slotKey);
    return ref;
  }

  writeEntry(context.store.slots, slotKey, value, context.expires);
  clearSlotIdentities(context.store.slots, slotKey);
  return undefined;
}

function normalizeEntity(entity: Record<string, unknown>, context: NormalizeContext): EntityRef {
  const ref = context.entityRefs.entity(String(entity["__typename"]), String(entity["id"]));

  for (const [key, value] of Object.entries(entity)) {
    if (isFieldValue(value)) {
      writeEntry(context.store.fields, entityFieldKey(ref, key), value, context.expires);
      continue;
    }

    normalizeValue(value, context, entityRelationKey(ref, { field: key }));
  }

  return ref;
}

function rootTarget(slotKey: string): NormalizeTarget {
  return { slotKey, fieldSteps: [] };
}

function ownerTarget(
  slotKey: string,
  ownerRef: EntityRef | undefined,
  fieldSteps: readonly SelectionStep[],
): NormalizeTarget {
  return { slotKey, ownerRef, fieldSteps };
}

function writeListRelation(
  store: CacheStore,
  slotKey: string,
  refs: readonly EntityRef[],
  expires: number,
): void {
  writeEntry(
    store.slots,
    suffixedSlotKey(slotKey, "ids"),
    refs.map((ref) => ref.id),
    expires,
  );
  writeEntry(store.slots, suffixedSlotKey(slotKey, "refs"), refs, expires);
  writeEntry(store.slots, slotKey, refs, expires);
}

function writeOwnerListRelation(
  store: CacheStore,
  ownerRef: EntityRef,
  step: SelectionStep,
  refs: readonly EntityRef[],
  expires: number,
): void {
  writeEntry(store.slots, entityRelationKey(ownerRef, step), refs, expires);
  writeEntry(
    store.slots,
    entityRelationKey(ownerRef, step, "ids"),
    refs.map((ref) => ref.id),
    expires,
  );
  writeEntry(store.slots, entityRelationKey(ownerRef, step, "refs"), refs, expires);
}

function clearEntityFieldPrefix(
  fields: Map<string, FieldEntry>,
  ref: EntityRef,
  fieldPrefix: string,
): void {
  const prefix = entityFieldKey(ref, `${fieldPrefix}.`);
  for (const [key, entry] of fields) {
    if (key.startsWith(prefix)) {
      entry.sig(undefined);
      entry.expires = 0;
    }
  }
}

function objectKind(meta: PlannerFieldMetadata): "entity" | "value" {
  if (meta.targetObjectKind) {
    return meta.targetObjectKind;
  }
  return meta.returnsEntity === false ? "value" : "entity";
}

function isFieldValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return !value.some(isEntityObject);
  }
  return value === null || typeof value !== "object" || !isEntityObject(value);
}

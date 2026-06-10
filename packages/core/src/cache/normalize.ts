import type {
  EntityRef,
  GQLensFieldContract,
  GQLensSchemaContract,
  GraphQLResult,
  SelectionStep,
} from "../types";
import { isEntityObject, isRecord } from "../guards";
import { fieldObjectKind, fieldReturnsList, fieldTypeName } from "../schema";
import {
  graphDataFieldKey,
  entityFieldKey,
  entityRelationKey,
  fieldStepForPath,
  suffixedSlotKey,
} from "./address";
import type { EntityRefStore } from "./entity";
import {
  clearSlotIdentities,
  deleteEntry,
  type GraphDataStoreRuntime,
  type GraphDataEntryStore,
  writeEntry,
} from "./store";

interface NormalizeContext {
  readonly store: GraphDataStoreRuntime;
  readonly entityRefs: EntityRefStore;
  readonly expires: number;
}

interface SchemaNormalizeContext extends NormalizeContext {
  readonly schema: GQLensSchemaContract;
}

interface NormalizeTarget {
  readonly slotKey: string;
  readonly ownerRef?: EntityRef | undefined;
  readonly fieldSteps: readonly SelectionStep[];
}

export function normalizeGraphQLResult(
  data: GraphQLResult,
  store: GraphDataStoreRuntime,
  entityRefs: EntityRefStore,
  expires: number,
  schema: GQLensSchemaContract | undefined,
): void {
  const context = { store, entityRefs, expires };
  for (const [rootField, value] of Object.entries(data)) {
    if (schema) {
      const root = schema.query.fields[rootField]
        ? schema.query
        : schema.mutation?.fields[rootField]
          ? schema.mutation
          : undefined;
      const field = root?.fields[rootField];
      if (root && field) {
        normalizeValueWithContract(
          value,
          field,
          { ...context, schema },
          rootTarget(`${root.type}.${rootField}`),
        );
        continue;
      }
    }

    const slotBase = `Query.${rootField}`;
    normalizeValue(value, context, slotBase);
  }
}

function normalizeValueWithContract(
  value: unknown,
  field: GQLensFieldContract,
  context: SchemaNormalizeContext,
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
      clearEntityFieldPrefix(store.fields, ownerRef, graphDataFieldKey(fieldSteps));
    }
    return null;
  }

  if (fieldReturnsList(field)) {
    if (!Array.isArray(value)) {
      writeEntry(store.slots, slotKey, value, expires);
      clearSlotIdentities(store.slots, slotKey);
      return undefined;
    }

    const typeName = fieldTypeName(field);
    if (!typeName) {
      writeLeafValue(value, context, target);
      return undefined;
    }

    if (fieldObjectKind(field) === "value") {
      writeEntry(store.slots, slotKey, value, expires);
      clearSlotIdentities(store.slots, slotKey);
      return undefined;
    }

    const refs = value.flatMap((item) =>
      isEntityObject(item) ? [normalizeEntityWithContract(item, context, typeName)] : [],
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

  const typeName = fieldTypeName(field);
  if (!typeName) {
    writeLeafValue(value, context, target);
    return undefined;
  }

  if (fieldObjectKind(field) === "value") {
    if (!isRecord(value)) {
      writeLeafValue(value, context, target);
      return undefined;
    }
    normalizeValueObjectWithContract(value, context, typeName, target);
    return undefined;
  }

  if (isEntityObject(value)) {
    const ref = normalizeEntityWithContract(value, context, typeName);
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

function normalizeEntityWithContract(
  entity: Record<string, unknown>,
  context: SchemaNormalizeContext,
  fallbackType: string,
): EntityRef {
  const typeName = typeof entity["__typename"] === "string" ? entity["__typename"] : fallbackType;
  const ref = context.entityRefs.entity(typeName, String(entity["id"]));
  const typeFields =
    context.schema.objects[typeName]?.fields ?? context.schema.objects[fallbackType]?.fields ?? {};

  for (const [key, value] of Object.entries(entity)) {
    const step: SelectionStep = { field: key };
    const field = typeFields[key];
    if (field) {
      normalizeValueWithContract(
        value,
        field,
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

function normalizeValueObjectWithContract(
  value: Record<string, unknown>,
  context: SchemaNormalizeContext,
  typeName: string,
  target: NormalizeTarget,
): void {
  const typeFields = context.schema.objects[typeName]?.fields ?? {};
  for (const [key, item] of Object.entries(value)) {
    const step: SelectionStep = { field: key };
    const nextSteps = [...target.fieldSteps, step];
    const field = typeFields[key];
    const nextTarget = ownerTarget(`${target.slotKey}.${key}`, target.ownerRef, nextSteps);
    if (field) {
      normalizeValueWithContract(item, field, context, nextTarget);
      continue;
    }
    writeLeafValue(item, context, nextTarget);
  }
}

function writeLeafValue(value: unknown, context: NormalizeContext, target: NormalizeTarget): void {
  if (target.ownerRef && target.fieldSteps.length > 0) {
    writeEntry(
      context.store.fields,
      entityFieldKey(target.ownerRef, graphDataFieldKey(target.fieldSteps)),
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
  store: GraphDataStoreRuntime,
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
  store: GraphDataStoreRuntime,
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
  fields: GraphDataEntryStore,
  ref: EntityRef,
  fieldPrefix: string,
): void {
  const prefix = entityFieldKey(ref, `${fieldPrefix}.`);
  for (const [key] of fields.records.entries()) {
    if (key.startsWith(prefix)) {
      deleteEntry(fields, key);
    }
  }
}

function isFieldValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return !value.some(isEntityObject);
  }
  return value === null || typeof value !== "object" || !isEntityObject(value);
}

import { relationSlotKey } from "./keys";
import { createSignal } from "./signal";
import type { EntityRef, FieldSignal, GraphQLResult, NormalizedCache } from "./types";

type FieldEntry<T = unknown> = FieldSignal<T>;

export function createNormalizedCache(): NormalizedCache {
  const fields = new Map<string, FieldEntry>();
  const slots = new Map<string, FieldEntry>();

  return {
    field<T = unknown>(ref: EntityRef, key: string): FieldSignal<T> {
      return getEntry<T>(fields, entityFieldKey(ref, key));
    },

    slot<T = unknown>(key: string): FieldSignal<T> {
      return getEntry<T>(slots, key);
    },

    entity(type: string, id: string): EntityRef {
      return { type, id };
    },

    normalize(data: GraphQLResult, ttl = 0): void {
      const expires = expiry(ttl);
      normalizeRoot(data, fields, slots, expires);
    },

    invalidate(ref: EntityRef, keys?: readonly string[]): void {
      if (keys && keys.length > 0) {
        for (const key of keys) {
          markStale(fields.get(entityFieldKey(ref, key)));
        }
        return;
      }

      const prefix = `${ref.type}:${ref.id}.`;
      for (const [key, entry] of fields) {
        if (key.startsWith(prefix)) {
          markStale(entry);
        }
      }
    },

    invalidateSlot(key: string): void {
      markStale(slots.get(key));
    },

    isCached(ref: EntityRef, fieldKey: string): boolean {
      return isFresh(fields.get(entityFieldKey(ref, fieldKey)));
    },

    isSlotCached(key: string): boolean {
      return isFresh(slots.get(key));
    },
  };
}

function getEntry<T>(store: Map<string, FieldEntry>, key: string): FieldSignal<T> {
  const existing = store.get(key);
  if (existing) {
    return existing as FieldSignal<T>;
  }

  const entry: FieldEntry<T> = {
    sig: createSignal<T>(undefined as T),
    expires: 0,
  };
  store.set(key, entry as FieldEntry);
  return entry;
}

function writeEntry<T>(
  store: Map<string, FieldEntry>,
  key: string,
  value: T,
  expires: number,
): void {
  const entry = getEntry<T>(store, key);
  entry.sig(value);
  entry.expires = expires;
}

function normalizeRoot(
  data: GraphQLResult,
  fields: Map<string, FieldEntry>,
  slots: Map<string, FieldEntry>,
  expires: number,
): void {
  for (const [rootField, value] of Object.entries(data)) {
    const slotBase = `Query.${rootField}`;
    normalizeValue(value, fields, slots, expires, slotBase);
  }
}

function normalizeValue(
  value: unknown,
  fields: Map<string, FieldEntry>,
  slots: Map<string, FieldEntry>,
  expires: number,
  slotKey: string,
): EntityRef | readonly EntityRef[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    writeEntry(slots, slotKey, null, expires);
    clearSlotIds(slots, slotKey);
    return null;
  }

  if (Array.isArray(value)) {
    if (!value.some(isEntityObject)) {
      writeEntry(slots, slotKey, value, expires);
      clearSlotIds(slots, slotKey);
      return undefined;
    }

    const refs = value.flatMap((item) =>
      isEntityObject(item) ? [normalizeEntity(item, fields, slots, expires)] : [],
    );
    writeEntry(
      slots,
      `${slotKey}.ids`,
      refs.map((ref) => ref.id),
      expires,
    );
    writeEntry(slots, slotKey, refs, expires);
    return refs;
  }

  if (isEntityObject(value)) {
    const ref = normalizeEntity(value, fields, slots, expires);
    writeEntry(slots, slotKey, ref, expires);
    clearSlotIds(slots, slotKey);
    return ref;
  }

  writeEntry(slots, slotKey, value, expires);
  clearSlotIds(slots, slotKey);
  return undefined;
}

function clearSlotIds(slots: Map<string, FieldEntry>, slotKey: string): void {
  const ids = slots.get(`${slotKey}.ids`);
  if (ids) {
    ids.sig(undefined);
    ids.expires = 0;
  }
}

function normalizeEntity(
  entity: Record<string, unknown>,
  fields: Map<string, FieldEntry>,
  slots: Map<string, FieldEntry>,
  expires: number,
): EntityRef {
  const ref = {
    type: String(entity["__typename"]),
    id: String(entity["id"]),
  };

  for (const [key, value] of Object.entries(entity)) {
    if (isFieldValue(value)) {
      writeEntry(fields, entityFieldKey(ref, key), value, expires);
      continue;
    }

    normalizeValue(value, fields, slots, expires, relationSlotKey(ref, { field: key }));
  }

  return ref;
}

function entityFieldKey(ref: EntityRef, key: string): string {
  return `${ref.type}:${ref.id}.${key}`;
}

function expiry(ttl: number): number {
  return ttl > 0 ? Date.now() + ttl : 0;
}

function isFresh(entry: FieldEntry | undefined): boolean {
  if (!entry) {
    return false;
  }
  if (entry.sig() === undefined) {
    return false;
  }
  return entry.expires === 0 || entry.expires > Date.now();
}

function markStale(entry: FieldEntry | undefined): void {
  if (entry) {
    entry.expires = Date.now() - 1;
  }
}

function isEntityObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "__typename" in value && "id" in value;
}

function isFieldValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return !value.some(isEntityObject);
  }
  return value === null || typeof value !== "object" || !isEntityObject(value);
}

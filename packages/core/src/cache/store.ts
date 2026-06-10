import { createSignal } from "../signal";
import type {
  AlienSignal,
  FieldSignal,
  GraphDataRecord,
  GraphDataRecordMap,
  GraphDataRecords,
} from "../types";
import { suffixedSlotKey, type GraphDataSlotSuffix } from "./address";

export type FieldEntry<T = unknown> = FieldSignal<T> & {
  writeLocal(value: T, expires: number): void;
  clearLocal(): void;
  markStaleLocal(expires: number): void;
};

export interface GraphDataEntryStore {
  readonly records: GraphDataRecordMap;
  readonly signals: Map<string, FieldEntry>;
}

export interface GraphDataStoreRuntime {
  readonly fields: GraphDataEntryStore;
  readonly slots: GraphDataEntryStore;
  dispose(): void;
}

export function createGraphDataStoreRuntime(
  records: GraphDataRecords = createMemoryRecords(),
): GraphDataStoreRuntime {
  const store: GraphDataStoreRuntime = {
    fields: { records: records.fields, signals: new Map<string, FieldEntry>() },
    slots: { records: records.slots, signals: new Map<string, FieldEntry>() },
    dispose(): void {
      disposeFields();
      disposeSlots();
    },
  };

  const disposeFields =
    records.fields.onEvict?.((key, record) => {
      evictEntry(store.fields, key, record);
    }) ?? noop;
  const disposeSlots =
    records.slots.onEvict?.((key, record) => {
      evictEntry(store.slots, key, record);
    }) ?? noop;

  return store;
}

export function createMemoryRecords(): GraphDataRecords {
  return {
    fields: new Map<string, GraphDataRecord>(),
    slots: new Map<string, GraphDataRecord>(),
  };
}

export function getEntry<T>(store: GraphDataEntryStore, key: string): FieldSignal<T> {
  const existing = store.signals.get(key);
  if (existing) {
    return existing as FieldSignal<T>;
  }

  const entry = createFieldEntry<T>(store, key, store.records.get(key));
  store.signals.set(key, entry as FieldEntry);
  return entry;
}

export function peekEntry<T>(store: GraphDataEntryStore, key: string): FieldSignal<T> | undefined {
  const existing = store.signals.get(key);
  if (existing) {
    return existing as FieldSignal<T>;
  }
  const record = store.records.get(key);
  if (!record) {
    return undefined;
  }
  const entry = createFieldEntry<T>(store, key, record);
  store.signals.set(key, entry as FieldEntry);
  return entry;
}

export function writeEntry<T>(
  store: GraphDataEntryStore,
  key: string,
  value: T,
  expires: number,
): void {
  store.records.set(key, { value, expires });
  const entry = store.signals.get(key) ?? createAndRememberEntry<T>(store, key);
  entry.writeLocal(value, expires);
}

export function deleteEntry(store: GraphDataEntryStore, key: string): void {
  store.records.delete(key);
  const entry = store.signals.get(key);
  if (entry) {
    entry.clearLocal();
    store.signals.delete(key);
  }
}

export function clearEntries(store: GraphDataEntryStore): void {
  store.records.clear();
  for (const entry of store.signals.values()) {
    entry.clearLocal();
  }
  store.signals.clear();
}

export function markEntryStale(store: GraphDataEntryStore, key: string): void {
  const record = store.records.get(key);
  if (!record) {
    return;
  }
  const expires = Date.now() - 1;
  const staleRecord = { value: record.value, expires };
  store.records.set(key, staleRecord);
  store.signals.get(key)?.markStaleLocal(expires);
}

export function isFreshEntry(store: GraphDataEntryStore, key: string): boolean {
  const record = store.records.get(key);
  if (!record) {
    return false;
  }
  return isExpiresFresh(record.expires);
}

export function clearSlotIdentities(slots: GraphDataEntryStore, slotKey: string): void {
  clearSlotSuffix(slots, slotKey, "ids");
  clearSlotSuffix(slots, slotKey, "refs");
}

export function clearSlotSuffix(
  slots: GraphDataEntryStore,
  slotKey: string,
  suffix: GraphDataSlotSuffix,
): void {
  deleteEntry(slots, suffixedSlotKey(slotKey, suffix));
}

export function expiresAt(ttl: number): number {
  return ttl > 0 ? Date.now() + ttl : 0;
}

export function isExpiresFresh(expires: number): boolean {
  return expires === 0 || expires > Date.now();
}

function createAndRememberEntry<T>(store: GraphDataEntryStore, key: string): FieldEntry<T> {
  const entry = createFieldEntry<T>(store, key, store.records.get(key));
  store.signals.set(key, entry as FieldEntry);
  return entry;
}

function createFieldEntry<T>(
  store: GraphDataEntryStore,
  key: string,
  record: GraphDataRecord | undefined,
): FieldEntry<T> {
  const raw = createSignal<T>(record?.value as T | undefined as T);
  let expires = record?.expires ?? 0;

  const sig = function (value?: T) {
    if (arguments.length === 0) {
      return raw();
    }
    if (value === undefined) {
      store.records.delete(key);
      raw(undefined as T);
      expires = 0;
      return undefined;
    }
    store.records.set(key, { value, expires });
    raw(value);
    return value;
  } as AlienSignal<T>;

  return {
    sig,

    get expires(): number {
      return expires;
    },

    set expires(next: number) {
      expires = next;
      const value = raw();
      if (value !== undefined) {
        store.records.set(key, { value, expires });
      }
    },

    writeLocal(value: T, nextExpires: number): void {
      expires = nextExpires;
      raw(value);
    },

    clearLocal(): void {
      expires = 0;
      raw(undefined as T);
    },

    markStaleLocal(nextExpires: number): void {
      expires = nextExpires;
    },
  };
}

function evictEntry(store: GraphDataEntryStore, key: string, _record: GraphDataRecord): void {
  const entry = store.signals.get(key);
  if (entry) {
    entry.clearLocal();
    store.signals.delete(key);
  }
}

const noop = (): void => undefined;

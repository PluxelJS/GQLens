import { createEntityRefStore } from "./cache/entity";
import {
  graphDataFieldKey,
  entityFieldKey,
  isListIdentityStep,
  suffixedSlotKey,
} from "./cache/address";
import { normalizeGraphQLResult } from "./cache/normalize";
import {
  clearEntries,
  createGraphDataStoreRuntime,
  deleteEntry,
  expiresAt,
  getEntry,
  isFreshEntry,
  markEntryStale,
  peekEntry,
  writeEntry,
  type GraphDataStoreRuntime,
  type FieldEntry,
  type GraphDataEntryStore,
} from "./cache/store";
import type {
  GraphDataAddress,
  GraphDataInvalidation,
  GraphDataPath,
  GraphDataTransaction,
  GraphDataNormalizeOptions,
  GraphDataWriteOptions,
  EntityRef,
  FieldSignal,
  GraphDataRecords,
  GraphDataRecord,
  GraphQLResult,
  GraphDataStore,
  GraphDataRuntimeStore,
  GQLensSchemaContract,
  SelectionPath,
} from "./types";
import { fieldIsAbstract, fieldTypeName, queryFieldContract } from "./schema";

export function createGraphDataStore(
  config: { readonly records?: GraphDataRecords } = {},
): GraphDataStore {
  const store = createGraphDataStoreRuntime(config.records);
  const entityRefs = createEntityRefStore();

  const graphStore: GraphDataRuntimeStore = {
    entry<T = unknown>(address: GraphDataAddress): FieldSignal<T> {
      return getEntry<T>(entryStore(store, address), publicAddressKey(address));
    },

    peek<T = unknown>(address: GraphDataAddress): FieldSignal<T> | undefined {
      return peekEntry<T>(entryStore(store, address), publicAddressKey(address));
    },

    read<T = unknown>(address: GraphDataAddress): T | undefined {
      return graphStore.peek<T>(address)?.sig();
    },

    write<T = unknown>(address: GraphDataAddress, value: T, options?: GraphDataWriteOptions): void {
      writeEntry(
        entryStore(store, address),
        publicAddressKey(address),
        value,
        expiresAt(options?.ttl ?? 0),
      );
    },

    isFresh(address: GraphDataAddress): boolean {
      return isFreshEntry(entryStore(store, address), publicAddressKey(address));
    },

    entity(type: string, id: string): EntityRef {
      return entityRefs.entity(type, id);
    },

    writeGraphQLResult(data: GraphQLResult, options: GraphDataNormalizeOptions = {}): void {
      const ttl = options.ttl ?? 0;
      normalizeGraphQLResult(data, store, entityRefs, expiresAt(ttl), options.schema);
    },

    invalidate(targetOrTargets: GraphDataInvalidation | readonly GraphDataInvalidation[]): void {
      const targets = Array.isArray(targetOrTargets) ? targetOrTargets : [targetOrTargets];
      for (const target of targets) {
        invalidateTarget(graphStore, store, target);
      }
    },

    clear(): void {
      clearEntries(store.fields);
      clearEntries(store.slots);
    },

    transaction<T>(run: (store: GraphDataStore) => T): GraphDataTransaction<T> {
      const snapshot = snapshotStore(store);
      const result = run(graphStore);
      return {
        result,
        rollback(): void {
          restoreStore(store, snapshot);
        },
      };
    },
  };

  return graphStore;
}

function publicAddressKey(address: GraphDataAddress): string {
  const suffix =
    address.facet && address.facet !== "value" && address.facet !== "link"
      ? address.facet
      : undefined;
  const pathKey = graphDataFieldKey(address.path);
  if (address.owner.kind === "root") {
    const base = `${address.owner.root}.${pathKey}`;
    return suffix ? suffixedSlotKey(base, suffix) : base;
  }
  const base = entityFieldKey(address.owner.ref, pathKey);
  return suffix ? suffixedSlotKey(base, suffix) : base;
}

function invalidateEntity(
  store: GraphDataStoreRuntime,
  ref: EntityRef,
  paths?: readonly GraphDataPath[],
): void {
  if (paths && paths.length > 0) {
    for (const path of paths) {
      invalidateAddressFamily(store, entityFieldKey(ref, graphDataFieldKey(path)));
    }
    return;
  }

  const prefix = `${ref.type}:${ref.id}.`;
  for (const entries of [store.fields, store.slots]) {
    for (const [key] of entries.records.entries()) {
      if (key.startsWith(prefix)) {
        markEntryStale(entries, key);
      }
    }
  }
}

function invalidateTarget(
  graphStore: GraphDataStore,
  store: GraphDataStoreRuntime,
  target: GraphDataInvalidation,
): void {
  if (target.kind === "address") {
    const key = publicAddressKey(target.address);
    if (target.family) {
      invalidateAddressFamily(store, key);
    } else {
      markEntryStale(entryStore(store, target.address), key);
    }
    return;
  }

  if (target.kind === "entity") {
    invalidateEntity(store, target.ref, target.paths);
    return;
  }

  if (target.kind === "root") {
    invalidateRootTarget(store, target.root, target.paths);
    return;
  }

  invalidateSelection(graphStore, store, target.path, target.schema);
}

function invalidateRootTarget(
  store: GraphDataStoreRuntime,
  root: string,
  paths: readonly GraphDataPath[] | undefined,
): void {
  if (paths && paths.length > 0) {
    for (const path of paths) {
      invalidateAddressFamily(store, publicAddressKey({ owner: { kind: "root", root }, path }));
    }
    return;
  }

  const prefix = `${root}.`;
  for (const [key] of store.slots.records.entries()) {
    if (key.startsWith(prefix)) {
      markEntryStale(store.slots, key);
    }
  }
}

function invalidateSelection(
  graphStore: GraphDataStore,
  store: GraphDataStoreRuntime,
  path: SelectionPath,
  schema: GQLensSchemaContract | undefined,
): void {
  const rootPath = isListIdentityStep(path.steps.at(-1)) ? path.steps.slice(0, -1) : path.steps;
  invalidateAddressFamily(
    store,
    publicAddressKey({ owner: { kind: "root", root: path.root }, path: rootPath }),
  );

  const [rootStep, ...rest] = path.steps;
  const keySteps = isListIdentityStep(rest.at(-1)) ? rest.slice(0, -1) : rest;
  const id = rootStep?.args?.["id"];
  const rootField = rootStep ? queryFieldContract(schema, rootStep.field) : undefined;
  const type = fieldTypeName(rootField);
  const isAbstract = fieldIsAbstract(rootField);
  if (!rootStep || keySteps.length === 0 || id === undefined || !type || isAbstract) {
    return;
  }
  invalidateEntity(store, graphStore.entity(type, String(id)), [keySteps]);
}

function invalidateAddressFamily(store: GraphDataStoreRuntime, key: string): void {
  markEntryStale(store.fields, key);
  markEntryStale(store.slots, key);
  markEntryStale(store.slots, suffixedSlotKey(key, "ids"));
  markEntryStale(store.slots, suffixedSlotKey(key, "refs"));
}

function entryStore(store: GraphDataStoreRuntime, address: GraphDataAddress): GraphDataEntryStore {
  if (
    address.owner.kind === "root" ||
    address.facet === "link" ||
    address.facet === "ids" ||
    address.facet === "refs"
  ) {
    return store.slots;
  }
  return store.fields;
}

interface StoreSnapshot {
  readonly fields: Map<string, EntrySnapshot>;
  readonly slots: Map<string, EntrySnapshot>;
}

interface EntrySnapshot {
  readonly entry?: FieldSignal<unknown> | undefined;
  readonly record?: GraphDataRecord | undefined;
}

function snapshotStore(store: GraphDataStoreRuntime): StoreSnapshot {
  return {
    fields: snapshotEntries(store.fields),
    slots: snapshotEntries(store.slots),
  };
}

function snapshotEntries(entries: GraphDataEntryStore): Map<string, EntrySnapshot> {
  const snapshot = new Map<string, EntrySnapshot>();
  for (const [key, record] of entries.records.entries()) {
    snapshot.set(key, { entry: entries.signals.get(key), record });
  }
  for (const [key, entry] of entries.signals) {
    if (!snapshot.has(key)) {
      snapshot.set(key, { entry });
    }
  }
  return snapshot;
}

function restoreStore(store: GraphDataStoreRuntime, snapshot: StoreSnapshot): void {
  restoreEntries(store.fields, snapshot.fields);
  restoreEntries(store.slots, snapshot.slots);
}

function restoreEntries(entries: GraphDataEntryStore, snapshot: Map<string, EntrySnapshot>): void {
  const currentKeys = new Set<string>([
    ...[...entries.records.entries()].map(([key]) => key),
    ...entries.signals.keys(),
  ]);

  for (const key of currentKeys) {
    if (!snapshot.has(key)) {
      deleteEntry(entries, key);
    }
  }

  for (const [key, saved] of snapshot) {
    if (!saved.record) {
      entries.records.delete(key);
      saved.entry?.sig(undefined);
      if (saved.entry) {
        entries.signals.set(key, saved.entry as FieldEntry);
      }
      continue;
    }

    entries.records.set(key, saved.record);
    const entry = entries.signals.get(key) ?? saved.entry;
    if (entry) {
      restoreEntry(entry, saved.record);
      entries.signals.set(key, entry as FieldEntry);
    }
  }
}

function restoreEntry(entry: FieldSignal<unknown>, record: GraphDataRecord): void {
  entry.expires = record.expires;
  entry.sig(record.value);
}

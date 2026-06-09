import { createEntityRefStore } from "./cache/entity";
import {
  cacheFieldKey,
  entityFieldKey,
  isListIdentityStep,
  suffixedSlotKey,
} from "./cache/address";
import { normalizeGraphQLResult } from "./cache/normalize";
import {
  createCacheStore,
  expiresAt,
  getEntry,
  isFresh,
  markStale,
  type CacheStore,
} from "./cache/store";
import type {
  CacheAddress,
  CacheInvalidation,
  CachePath,
  CacheTransaction,
  CacheWriteOptions,
  EntityRef,
  FieldSignal,
  GraphQLResult,
  NormalizedCache,
  PlannerMetadata,
  SelectionPath,
} from "./types";

export function createNormalizedCache(): NormalizedCache {
  const store = createCacheStore();
  const entityRefs = createEntityRefStore();

  const cache: NormalizedCache = {
    entry<T = unknown>(address: CacheAddress): FieldSignal<T> {
      return getEntry<T>(entryStore(store, address), publicAddressKey(address));
    },

    peek<T = unknown>(address: CacheAddress): FieldSignal<T> | undefined {
      return entryStore(store, address).get(publicAddressKey(address)) as
        | FieldSignal<T>
        | undefined;
    },

    read<T = unknown>(address: CacheAddress): T | undefined {
      return cache.peek<T>(address)?.sig();
    },

    write<T = unknown>(address: CacheAddress, value: T, options?: CacheWriteOptions): void {
      const entry = cache.entry<T>(address);
      entry.sig(value);
      entry.expires = expiresAt(options?.ttl ?? 0);
    },

    isFresh(address: CacheAddress): boolean {
      return isFresh(entryStore(store, address).get(publicAddressKey(address)));
    },

    entity(type: string, id: string): EntityRef {
      return entityRefs.entity(type, id);
    },

    normalize(data: GraphQLResult, ttl = 0, metadata?: PlannerMetadata): void {
      normalizeGraphQLResult(data, store, entityRefs, expiresAt(ttl), metadata);
    },

    invalidate(targetOrTargets: CacheInvalidation | readonly CacheInvalidation[]): void {
      const targets = Array.isArray(targetOrTargets) ? targetOrTargets : [targetOrTargets];
      for (const target of targets) {
        invalidateTarget(cache, store, target);
      }
    },

    clear(): void {
      store.fields.clear();
      store.slots.clear();
    },

    transaction<T>(run: (cache: NormalizedCache) => T): CacheTransaction<T> {
      const snapshot = snapshotStore(store);
      const result = run(cache);
      return {
        result,
        rollback(): void {
          restoreStore(store, snapshot);
        },
      };
    },
  };

  return cache;
}

function publicAddressKey(address: CacheAddress): string {
  const suffix =
    address.facet && address.facet !== "value" && address.facet !== "link"
      ? address.facet
      : undefined;
  const pathKey = cacheFieldKey(address.path);
  if (address.owner.kind === "root") {
    const base = `${address.owner.root}.${pathKey}`;
    return suffix ? suffixedSlotKey(base, suffix) : base;
  }
  const base = entityFieldKey(address.owner.ref, pathKey);
  return suffix ? suffixedSlotKey(base, suffix) : base;
}

function invalidateEntity(store: CacheStore, ref: EntityRef, paths?: readonly CachePath[]): void {
  if (paths && paths.length > 0) {
    for (const path of paths) {
      invalidateAddressFamily(store, entityFieldKey(ref, cacheFieldKey(path)));
    }
    return;
  }

  const prefix = `${ref.type}:${ref.id}.`;
  for (const entries of [store.fields, store.slots]) {
    for (const [key, entry] of entries) {
      if (key.startsWith(prefix)) {
        markStale(entry);
      }
    }
  }
}

function invalidateTarget(
  cache: NormalizedCache,
  store: CacheStore,
  target: CacheInvalidation,
): void {
  if (target.kind === "address") {
    const key = publicAddressKey(target.address);
    if (target.family) {
      invalidateAddressFamily(store, key);
    } else {
      markStale(entryStore(store, target.address).get(key));
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

  invalidateSelection(cache, store, target.path, target.metadata);
}

function invalidateRootTarget(
  store: CacheStore,
  root: string,
  paths: readonly CachePath[] | undefined,
): void {
  if (paths && paths.length > 0) {
    for (const path of paths) {
      invalidateAddressFamily(store, publicAddressKey({ owner: { kind: "root", root }, path }));
    }
    return;
  }

  const prefix = `${root}.`;
  for (const [key, entry] of store.slots) {
    if (key.startsWith(prefix)) {
      markStale(entry);
    }
  }
}

function invalidateSelection(
  cache: NormalizedCache,
  store: CacheStore,
  path: SelectionPath,
  metadata: PlannerMetadata | undefined,
): void {
  const rootPath = isListIdentityStep(path.steps.at(-1)) ? path.steps.slice(0, -1) : path.steps;
  invalidateAddressFamily(
    store,
    publicAddressKey({ owner: { kind: "root", root: path.root }, path: rootPath }),
  );

  const [rootStep, ...rest] = path.steps;
  const keySteps = isListIdentityStep(rest.at(-1)) ? rest.slice(0, -1) : rest;
  const id = rootStep?.args?.["id"];
  const type = rootStep ? metadata?.roots?.[rootStep.field]?.graphQLType : undefined;
  const isAbstract = rootStep ? metadata?.roots?.[rootStep.field]?.isAbstract : undefined;
  if (!rootStep || keySteps.length === 0 || id === undefined || !type || isAbstract) {
    return;
  }
  invalidateEntity(store, cache.entity(type, String(id)), [keySteps]);
}

function invalidateAddressFamily(store: CacheStore, key: string): void {
  markStale(store.fields.get(key));
  markStale(store.slots.get(key));
  markStale(store.slots.get(suffixedSlotKey(key, "ids")));
  markStale(store.slots.get(suffixedSlotKey(key, "refs")));
}

function entryStore(store: CacheStore, address: CacheAddress): Map<string, FieldSignal> {
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
  readonly entry: FieldSignal<unknown>;
  readonly value: unknown;
  readonly expires: number;
}

function snapshotStore(store: CacheStore): StoreSnapshot {
  return {
    fields: snapshotEntries(store.fields),
    slots: snapshotEntries(store.slots),
  };
}

function snapshotEntries(entries: Map<string, FieldSignal>): Map<string, EntrySnapshot> {
  return new Map(
    [...entries].map(([key, entry]) => [
      key,
      { entry, value: entry.sig(), expires: entry.expires },
    ]),
  );
}

function restoreStore(store: CacheStore, snapshot: StoreSnapshot): void {
  restoreEntries(store.fields, snapshot.fields);
  restoreEntries(store.slots, snapshot.slots);
}

function restoreEntries(
  entries: Map<string, FieldSignal>,
  snapshot: Map<string, EntrySnapshot>,
): void {
  for (const [key, entry] of entries) {
    const saved = snapshot.get(key);
    if (saved && saved.entry === entry) {
      restoreEntry(entry, saved);
      continue;
    }
    entry.sig(undefined);
    entry.expires = 0;
    entries.delete(key);
  }

  for (const [key, saved] of snapshot) {
    restoreEntry(saved.entry, saved);
    entries.set(key, saved.entry);
  }
}

function restoreEntry(entry: FieldSignal<unknown>, snapshot: EntrySnapshot): void {
  entry.sig(snapshot.value);
  entry.expires = snapshot.expires;
}

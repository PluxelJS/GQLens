import { createSelectionCollector, type ReaderHandle } from "./collector";
import { applyInvalidations } from "./invalidation";
import { relationSlotKey, slotKey, stepKey } from "./keys";
import { plan } from "./planner";
import { createSignal } from "./signal";
import type {
  EntityRef,
  GraphQLResult,
  InvalidationInput,
  NormalizedCache,
  PlannedSelectionPath,
  PlannedSelectionStep,
  PlannerMetadata,
  QuerySessionConfig,
  SelectionPath,
  SelectionStep,
} from "./types";
import type { Fetcher, LiveSubscriber } from "./transport";

interface OwnerResolution {
  readonly value: EntityRef | null | undefined;
  readonly fresh: boolean;
}

interface SlotSnapshot<T> {
  readonly value: T | undefined;
  readonly fresh: boolean;
}

export interface QuerySession {
  readonly cache: NormalizedCache;
  mount(): ReaderHandle;
  unmount(reader: ReaderHandle): void;
  begin(reader: ReaderHandle): void;
  select(reader: ReaderHandle, path: SelectionPath): void;
  commit(reader: ReaderHandle): void;
  discard(reader: ReaderHandle): void;
  replace(reader: ReaderHandle, paths: readonly SelectionPath[]): void;
  readonly loading: () => boolean;
  readonly error: () => Error | null;
  schedule(): void;
  refetch(): void;
  invalidate(specs: readonly InvalidationInput[]): void;
  invalidateRoot(rootName: string, args?: Record<string, unknown>): void;
}

export function createQuerySession(
  cache: NormalizedCache,
  fetcher: Fetcher,
  config: QuerySessionConfig = {},
  metadataArg?: PlannerMetadata,
): QuerySession {
  const policy = config.policy ?? "cache-and-network";
  const ttl = config.ttl ?? 0;
  const metadata = config.metadata ?? metadataArg;
  const collector = createSelectionCollector();
  const loading = createSignal(false);
  const error = createSignal<Error | null>(null);
  const inflight = new Set<string>();
  const completed = new Set<string>();
  let scheduled = false;
  let forceNext = false;

  function schedule(force = false): void {
    forceNext ||= force;
    if (scheduled) {
      return;
    }
    scheduled = true;

    queueMicrotask(() => {
      scheduled = false;
      const paths = collector.snapshot();
      if (paths.length === 0) {
        return;
      }

      const fresh = paths.every((path) => isPathFresh(cache, path, metadata));
      const forced = forceNext;
      forceNext = false;
      if (!forced && policy === "cache-first" && fresh) {
        return;
      }

      const operation = plan(paths, "query", metadata);
      const key = `${operation.query}\n${JSON.stringify(operation.variables)}`;
      if (
        !forced &&
        completed.has(key) &&
        ((policy === "cache-and-network" && fresh) || policy === "network-only")
      ) {
        return;
      }
      if (inflight.has(key)) {
        return;
      }

      inflight.add(key);
      loading(true);
      error(null);

      fetcher(operation)
        .then((data) => {
          const result = readGraphQLData(data);
          cache.normalize(result, ttl);
          syncSlots(cache, result, operation.selections, ttl, metadata);
          completed.add(key);
          return undefined;
        })
        .catch((reason) => {
          error(reason instanceof Error ? reason : new Error(String(reason)));
        })
        .finally(() => {
          inflight.delete(key);
          loading(inflight.size > 0);
        });
    });
  }

  return {
    cache,

    mount(): ReaderHandle {
      return collector.register();
    },

    unmount(reader: ReaderHandle): void {
      collector.unregister(reader);
    },

    begin(reader: ReaderHandle): void {
      collector.begin(reader);
    },

    select(reader: ReaderHandle, path: SelectionPath): void {
      collector.select(reader, path);
    },

    commit(reader: ReaderHandle): void {
      collector.commit(reader);
    },

    discard(reader: ReaderHandle): void {
      collector.discard(reader);
    },

    replace(reader: ReaderHandle, paths: readonly SelectionPath[]): void {
      collector.replace(reader, paths);
    },

    loading(): boolean {
      return loading();
    },

    error(): Error | null {
      return error();
    },

    schedule,

    refetch(): void {
      completed.clear();
      schedule(true);
    },

    invalidate(specs: readonly InvalidationInput[]): void {
      applyInvalidations(cache, specs, metadata);
      completed.clear();
      schedule(true);
    },

    invalidateRoot(rootName: string, args?: Record<string, unknown>): void {
      const rootStep: SelectionStep = { field: rootName, args };
      cache.invalidateSlot(slotKey("Query", [rootStep]));
      cache.invalidateSlot(slotKey("Query", [rootStep], "ids"));
      cache.invalidateSlot(slotKey("Query", [rootStep], "refs"));
      completed.clear();
      schedule(true);
    },
  };
}

export function createLiveQuerySession(
  cache: NormalizedCache,
  subscribe: LiveSubscriber,
  config: QuerySessionConfig = {},
  metadataArg?: PlannerMetadata,
): QuerySession {
  const ttl = config.ttl ?? 0;
  const metadata = config.metadata ?? metadataArg;
  const collector = createSelectionCollector();
  const loading = createSignal(false);
  const error = createSignal<Error | null>(null);
  let scheduled = false;
  let forceNext = false;
  let activeKey = "";
  let unsubscribe: (() => void) | null = null;

  function schedule(force = false): void {
    forceNext ||= force;
    if (scheduled) {
      return;
    }
    scheduled = true;

    queueMicrotask(() => {
      scheduled = false;
      const paths = collector.snapshot();
      if (paths.length === 0) {
        unsubscribe?.();
        unsubscribe = null;
        activeKey = "";
        loading(false);
        return;
      }

      const operation = plan(paths, "query", metadata);
      const key = `${operation.query}\n${JSON.stringify(operation.variables)}`;
      const forced = forceNext;
      forceNext = false;
      if (!forced && key === activeKey) {
        return;
      }

      unsubscribe?.();
      activeKey = key;
      loading(true);
      error(null);

      try {
        unsubscribe = subscribe(
          operation,
          (data) => {
            const result = readGraphQLData(data);
            cache.normalize(result, ttl);
            syncSlots(cache, result, operation.selections, ttl, metadata);
            loading(false);
          },
          (reason) => {
            error(reason);
            loading(false);
          },
        );
      } catch (reason) {
        unsubscribe = null;
        activeKey = "";
        error(reason instanceof Error ? reason : new Error(String(reason)));
        loading(false);
      }
    });
  }

  return {
    cache,

    mount(): ReaderHandle {
      return collector.register();
    },

    unmount(reader: ReaderHandle): void {
      collector.unregister(reader);
      schedule();
    },

    begin(reader: ReaderHandle): void {
      collector.begin(reader);
    },

    select(reader: ReaderHandle, path: SelectionPath): void {
      collector.select(reader, path);
    },

    commit(reader: ReaderHandle): void {
      collector.commit(reader);
    },

    discard(reader: ReaderHandle): void {
      collector.discard(reader);
    },

    replace(reader: ReaderHandle, paths: readonly SelectionPath[]): void {
      collector.replace(reader, paths);
    },

    loading(): boolean {
      return loading();
    },

    error(): Error | null {
      return error();
    },

    schedule,

    refetch(): void {
      schedule(true);
    },

    invalidate(specs: readonly InvalidationInput[]): void {
      applyInvalidations(cache, specs, metadata);
      schedule(true);
    },

    invalidateRoot(rootName: string, args?: Record<string, unknown>): void {
      const rootStep: SelectionStep = { field: rootName, args };
      cache.invalidateSlot(slotKey("Query", [rootStep]));
      cache.invalidateSlot(slotKey("Query", [rootStep], "ids"));
      cache.invalidateSlot(slotKey("Query", [rootStep], "refs"));
      schedule(true);
    },
  };
}

function readGraphQLData(data: unknown): GraphQLResult {
  if (isRecord(data) && "data" in data && isRecord(data["data"])) {
    return data["data"];
  }
  return (data ?? {}) as GraphQLResult;
}

function isPathFresh(
  cache: NormalizedCache,
  path: SelectionPath,
  metadata: PlannerMetadata | undefined,
): boolean {
  if (path.steps.length === 0) {
    return false;
  }
  const last = path.steps[path.steps.length - 1];
  if (!last) {
    return false;
  }

  if (isListIdentityStep(last)) {
    return isListPathFresh(cache, path, metadata);
  }

  const owner = resolveOwner(cache, path, metadata);
  if (owner.value === null) {
    return owner.fresh;
  }
  if (owner.value) {
    return owner.fresh && cache.isCached(owner.value, cacheFieldKey(last));
  }

  return cache.isSlotCached(slotKey(path.root, path.steps));
}

function syncSlots(
  cache: NormalizedCache,
  data: GraphQLResult,
  paths: readonly PlannedSelectionPath[],
  ttl: number,
  metadata: PlannerMetadata | undefined,
): void {
  const expires = ttl > 0 ? Date.now() + ttl : 0;
  const seen = new Set<string>();

  for (const path of paths) {
    syncPathSlots(cache, data, path, expires, seen, metadata);
  }
}

function syncPathSlots(
  cache: NormalizedCache,
  data: GraphQLResult,
  path: PlannedSelectionPath,
  expires: number,
  seen: Set<string>,
  metadata: PlannerMetadata | undefined,
): void {
  let current: unknown = data;
  const originalSteps: PlannedSelectionStep[] = [];

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

    const parentRef = isEntity(current) ? entityFrom(current) : undefined;
    current = current[step.responseKey ?? step.field];
    const nextStep = path.steps[index + 1];
    const normalized = toSlotValue(current, isListIdentityStep(nextStep));
    if (normalized === undefined) {
      continue;
    }

    const steps = originalSteps.map(({ field, args }) => ({ field, args }));
    const key = slotKey(path.root, steps);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const slot = cache.slot(key);
    slot.sig(normalized);
    slot.expires = expires;

    if (Array.isArray(normalized)) {
      const identityStep = path.steps[index + 1];
      if (identityStep?.field === "refs") {
        const refsSlot = cache.slot<readonly EntityRef[]>(slotKey(path.root, steps, "refs"));
        refsSlot.sig(normalized);
        refsSlot.expires = expires;
        clearSlotSuffix(cache, key, "ids");
      } else {
        const idsSlot = cache.slot<readonly string[]>(slotKey(path.root, steps, "ids"));
        idsSlot.sig(normalized.map((ref) => ref.id));
        idsSlot.expires = expires;
        clearSlotSuffix(cache, key, "refs");
      }
      writeRelationSlot(cache, parentRef, step, normalized, expires);
      if (identityStep?.field === "refs") {
        writeRelationSlot(cache, parentRef, step, normalized, expires, "refs");
        clearRelationSlotSuffix(cache, parentRef, step, "ids");
      } else {
        writeRelationSlot(
          cache,
          parentRef,
          step,
          normalized.map((ref) => ref.id),
          expires,
          "ids",
        );
        clearRelationSlotSuffix(cache, parentRef, step, "refs");
      }
    } else if (normalized && "type" in normalized && parentRef) {
      clearSlotSuffix(cache, key, "ids");
      clearSlotSuffix(cache, key, "refs");
      writeRelationSlot(cache, parentRef, step, normalized, expires);
    } else {
      clearSlotSuffix(cache, key, "ids");
      clearSlotSuffix(cache, key, "refs");
      clearRelationSlotSuffix(cache, parentRef, step, "ids");
      clearRelationSlotSuffix(cache, parentRef, step, "refs");
    }
  }
}

function writeRelationSlot(
  cache: NormalizedCache,
  ref: EntityRef | undefined,
  step: SelectionStep,
  value: EntityRef | readonly EntityRef[] | readonly string[],
  expires: number,
  suffix?: string,
): void {
  if (!ref) {
    return;
  }
  const slot = cache.slot(relationSlotKey(ref, step, suffix));
  slot.sig(value);
  slot.expires = expires;
}

function clearRelationSlotSuffix(
  cache: NormalizedCache,
  ref: EntityRef | undefined,
  step: SelectionStep,
  suffix: string,
): void {
  if (ref) {
    clearSlotSuffix(cache, relationSlotKey(ref, step), suffix);
  }
}

function clearSlotSuffix(cache: NormalizedCache, key: string, suffix: string): void {
  const slot = cache.slot<unknown>(`${key}.${suffix}`);
  slot.sig(undefined);
  slot.expires = 0;
}

function toSlotValue(
  value: unknown,
  expectsListIdentity: boolean,
): EntityRef | readonly EntityRef[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    if (!expectsListIdentity && !value.some(isEntity)) {
      return undefined;
    }
    return value.flatMap((item) => (isEntity(item) ? [entityFrom(item)] : []));
  }
  if (isEntity(value)) {
    return entityFrom(value);
  }
  return undefined;
}

function isEntity(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "__typename" in value && "id" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function entityFrom(value: Record<string, unknown>): EntityRef {
  return { type: String(value["__typename"]), id: String(value["id"]) };
}

function isListPathFresh(
  cache: NormalizedCache,
  path: SelectionPath,
  metadata: PlannerMetadata | undefined,
): boolean {
  const relationStep = path.steps[path.steps.length - 2];
  const identityStep = path.steps[path.steps.length - 1];
  if (!relationStep) {
    return false;
  }

  const relationSteps = path.steps.slice(0, -1);
  if (relationSteps.length === 1) {
    return isListSlotFresh(cache, slotKey(path.root, relationSteps), identityStep?.field);
  }

  const owner = resolveOwnerForSteps(cache, path.root, relationSteps.slice(0, -1), metadata);
  if (owner.value === null) {
    return owner.fresh;
  }
  return owner.value && owner.fresh
    ? isListSlotFresh(cache, relationSlotKey(owner.value, relationStep), identityStep?.field)
    : false;
}

function resolveOwner(
  cache: NormalizedCache,
  path: SelectionPath,
  metadata: PlannerMetadata | undefined,
): OwnerResolution {
  return resolveOwnerForSteps(cache, path.root, path.steps.slice(0, -1), metadata);
}

function resolveOwnerForSteps(
  cache: NormalizedCache,
  root: string,
  steps: readonly SelectionStep[],
  metadata: PlannerMetadata | undefined,
): OwnerResolution {
  let ref: EntityRef | undefined;
  let fresh = true;
  const walked: SelectionStep[] = [];

  for (const step of steps) {
    walked.push(step);

    if (step.typeCondition) {
      if (!ref || !matchesRefTypeCondition(ref, step.typeCondition, metadata)) {
        return { value: null, fresh };
      }
      continue;
    }

    if (!ref) {
      const rootSlot = readSlot<EntityRef | null>(cache, slotKey(root, walked));
      if (rootSlot.value !== undefined) {
        if (!rootSlot.value) {
          return { value: null, fresh: rootSlot.fresh };
        }
        ref = rootSlot.value;
        fresh &&= rootSlot.fresh;
        continue;
      }

      const typeName = metadata?.roots?.[step.field]?.graphQLType;
      const id = step.args?.["id"];
      if (typeName && id !== undefined) {
        ref = cache.entity(typeName, String(id));
        continue;
      }

      return { value: undefined, fresh: false };
    }

    const relationSlot = readSlot<EntityRef | null>(cache, relationSlotKey(ref, step));
    if (relationSlot.value === undefined) {
      return { value: undefined, fresh: false };
    }
    if (!relationSlot.value) {
      return { value: null, fresh: fresh && relationSlot.fresh };
    }
    ref = relationSlot.value;
    fresh &&= relationSlot.fresh;
  }

  return ref ? { value: ref, fresh } : { value: undefined, fresh: false };
}

function isListSlotFresh(
  cache: NormalizedCache,
  key: string,
  identityField: string | undefined,
): boolean {
  if (identityField === "refs") {
    const refs = readSlot<readonly EntityRef[]>(cache, `${key}.refs`);
    return refs.value !== undefined ? refs.fresh : false;
  }

  if (identityField === "ids") {
    const ids = readSlot<readonly string[]>(cache, `${key}.ids`);
    return ids.value !== undefined ? ids.fresh : false;
  }

  const relation = readSlot<readonly EntityRef[] | null>(cache, key);
  return relation.value === null ? relation.fresh : false;
}

function readSlot<T>(cache: NormalizedCache, key: string): SlotSnapshot<T> {
  const entry = cache.slot<T | undefined>(key);
  const value = entry.sig();
  return {
    value,
    fresh: value !== undefined && isFreshEntry(entry),
  };
}

function isFreshEntry(entry: { readonly expires: number }): boolean {
  return entry.expires === 0 || entry.expires > Date.now();
}

function cacheFieldKey(step: SelectionStep): string {
  return stepKey(step);
}

function isListIdentityStep(step: SelectionStep | undefined): boolean {
  return step?.field === "ids" || step?.field === "refs";
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

function matchesRefTypeCondition(
  ref: EntityRef,
  typeCondition: string,
  metadata: PlannerMetadata | undefined,
): boolean {
  return (
    ref.type === typeCondition ||
    (metadata?.types?.[typeCondition]?.["__typename"]?.possibleTypes?.includes(ref.type) ?? false)
  );
}

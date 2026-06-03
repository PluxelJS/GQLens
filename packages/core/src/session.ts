import { createSelectionCollector, type ReaderHandle } from "./collector";
import { slotKey, stepKey } from "./keys";
import { plan } from "./planner";
import { createSignal } from "./signal";
import type {
  EntityRef,
  GraphQLResult,
  InvalidationSpec,
  NormalizedCache,
  PlannedSelectionPath,
  PlannedSelectionStep,
  PlannerMetadata,
  QuerySessionConfig,
  SelectionPath,
  SelectionStep,
} from "./types";
import type { Fetcher, LiveSubscriber } from "./transport";

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
  invalidate(specs: readonly InvalidationSpec[]): void;
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
          const result = (data ?? {}) as GraphQLResult;
          cache.normalize(result, ttl);
          syncSlots(cache, result, operation.selections, ttl);
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

    invalidate(specs: readonly InvalidationSpec[]): void {
      applyInvalidations(cache, specs);
      completed.clear();
      schedule(true);
    },

    invalidateRoot(rootName: string, args?: Record<string, unknown>): void {
      const rootStep: SelectionStep = { field: rootName, args };
      cache.invalidateSlot(slotKey("Query", [rootStep]));
      cache.invalidateSlot(slotKey("Query", [rootStep], "ids"));
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
            syncSlots(cache, result, operation.selections, ttl);
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

    invalidate(specs: readonly InvalidationSpec[]): void {
      applyInvalidations(cache, specs);
      schedule(true);
    },

    invalidateRoot(rootName: string, args?: Record<string, unknown>): void {
      const rootStep: SelectionStep = { field: rootName, args };
      cache.invalidateSlot(slotKey("Query", [rootStep]));
      cache.invalidateSlot(slotKey("Query", [rootStep], "ids"));
      schedule(true);
    },
  };
}

function applyInvalidations(cache: NormalizedCache, specs: readonly InvalidationSpec[]): void {
  for (const spec of specs) {
    cache.invalidate(cache.entity(spec.type, spec.id), spec.keys);
  }
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

  if (last.field === "ids") {
    return isListPathFresh(cache, path, metadata);
  }

  const owner = resolveOwnerRef(cache, path, metadata);
  if (owner) {
    return cache.isCached(owner, cacheFieldKey(last));
  }

  return cache.isSlotCached(slotKey(path.root, path.steps));
}

function syncSlots(
  cache: NormalizedCache,
  data: GraphQLResult,
  paths: readonly PlannedSelectionPath[],
  ttl: number,
): void {
  const expires = ttl > 0 ? Date.now() + ttl : 0;
  const seen = new Set<string>();

  for (const path of paths) {
    syncPathSlots(cache, data, path, expires, seen);
  }
}

function syncPathSlots(
  cache: NormalizedCache,
  data: GraphQLResult,
  path: PlannedSelectionPath,
  expires: number,
  seen: Set<string>,
): void {
  let current: unknown = data;
  const originalSteps: PlannedSelectionStep[] = [];

  for (const step of path.steps) {
    originalSteps.push(step);
    if (step.field === "ids") {
      continue;
    }
    if (!isRecord(current)) {
      return;
    }

    const parentRef = isEntity(current) ? entityFrom(current) : undefined;
    current = current[step.responseKey ?? step.field];
    const normalized = toSlotValue(current);
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
      const idsSlot = cache.slot<readonly string[]>(slotKey(path.root, steps, "ids"));
      idsSlot.sig(normalized.map((ref) => ref.id));
      idsSlot.expires = expires;
      if (parentRef) {
        const field = cache.field<readonly string[]>(parentRef, `${cacheFieldKey(step)}_ids`);
        field.sig(normalized.map((ref) => ref.id));
        field.expires = expires;
      }
    } else if (normalized && "type" in normalized && parentRef) {
      const field = cache.field<EntityRef>(parentRef, `${cacheFieldKey(step)}_ref`);
      field.sig(normalized);
      field.expires = expires;
    }
  }
}

function toSlotValue(value: unknown): EntityRef | readonly EntityRef[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
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
  if (!relationStep) {
    return false;
  }

  const relationSteps = path.steps.slice(0, -1);
  if (relationSteps.length === 1) {
    return cache.isSlotCached(slotKey(path.root, relationSteps, "ids"));
  }

  const owner = resolveOwnerRefForSteps(cache, path.root, relationSteps.slice(0, -1), metadata);
  return owner ? cache.isCached(owner, `${cacheFieldKey(relationStep)}_ids`) : false;
}

function resolveOwnerRef(
  cache: NormalizedCache,
  path: SelectionPath,
  metadata: PlannerMetadata | undefined,
): EntityRef | undefined {
  return resolveOwnerRefForSteps(cache, path.root, path.steps.slice(0, -1), metadata);
}

function resolveOwnerRefForSteps(
  cache: NormalizedCache,
  root: string,
  steps: readonly SelectionStep[],
  metadata: PlannerMetadata | undefined,
): EntityRef | undefined {
  let ref: EntityRef | undefined;
  const walked: SelectionStep[] = [];

  for (const step of steps) {
    walked.push(step);

    if (!ref) {
      const typeName = metadata?.roots?.[step.field]?.graphQLType;
      const id = step.args?.["id"];
      if (typeName && id !== undefined) {
        ref = cache.entity(typeName, String(id));
        continue;
      }

      if (!cache.isSlotCached(slotKey(root, walked))) {
        return undefined;
      }
      const value = cache.slot<EntityRef | null>(slotKey(root, walked)).sig();
      if (!value) {
        return undefined;
      }
      ref = value;
      continue;
    }

    const key = `${cacheFieldKey(step)}_ref`;
    if (!cache.isCached(ref, key)) {
      return undefined;
    }
    const next = cache.field<EntityRef | undefined>(ref, key).sig();
    if (!next) {
      return undefined;
    }
    ref = next;
  }

  return ref;
}

function cacheFieldKey(step: SelectionStep): string {
  return stepKey(step);
}

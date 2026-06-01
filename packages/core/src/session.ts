import { createSelectionCollector, type ReaderHandle } from "./collector";
import { slotKey } from "./keys";
import { plan } from "./planner";
import { createSignal } from "./signal";
import type {
  EntityRef,
  GraphQLResult,
  NormalizedCache,
  PlannedSelectionPath,
  PlannedSelectionStep,
  PlannerMetadata,
  QuerySessionConfig,
  SelectionPath,
  SelectionStep,
} from "./types";
import type { Fetcher } from "./transport";

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
  let scheduled = false;

  function schedule(): void {
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
      if (policy === "cache-first" && paths.every((path) => isPathFresh(cache, path))) {
        return;
      }

      const operation = plan(paths, "query", metadata);
      const key = `${operation.query}\n${JSON.stringify(operation.variables)}`;
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

    invalidateRoot(rootName: string, args?: Record<string, unknown>): void {
      const rootStep: SelectionStep = { field: rootName, args };
      cache.invalidateSlot(slotKey("Query", [rootStep]));
      cache.invalidateSlot(slotKey("Query", [rootStep], "ids"));
      schedule();
    },
  };
}

function isPathFresh(cache: NormalizedCache, path: SelectionPath): boolean {
  if (path.steps.length === 0) {
    return false;
  }
  const last = path.steps[path.steps.length - 1];
  if (!last) {
    return false;
  }
  const asSlot = slotKey(path.root, path.steps);
  if (cache.isSlotCached(asSlot)) {
    return true;
  }
  if (last.field === "ids") {
    return cache.isSlotCached(slotKey(path.root, path.steps.slice(0, -1), "ids"));
  }
  return false;
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

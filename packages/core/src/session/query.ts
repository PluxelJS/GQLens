import { createSelectionCollector } from "../collector";
import { isSelectionFresh } from "../cache/freshness";
import { writeOperationResult } from "../cache/materialize";
import { expiresAt, isExpiresFresh } from "../cache/store";
import { applyInvalidations } from "../invalidation";
import { createSignal } from "../signal";
import type { GraphDataStore, QuerySessionConfig } from "../types";
import type { Fetcher } from "../transport";
import { createPlanCache, operationKey, planCached } from "./operation-cache";
import type { QuerySession } from "./types";

/** Runtime dependencies and execution settings for a query session. */
export interface QuerySessionOptions extends QuerySessionConfig {
  /** Graph data store read before fetches and updated after successful results. */
  readonly store: GraphDataStore;
  /** Transport used to execute planned GraphQL operations. */
  readonly fetcher: Fetcher;
}

export function createQuerySession(options: QuerySessionOptions): QuerySession {
  const { store, fetcher } = options;
  const policy = options.policy ?? "cache-and-network";
  const ttl = options.ttl ?? 0;
  const metadata = options.metadata;
  const collector = createSelectionCollector();
  const loading = createSignal(false);
  const error = createSignal<Error | null>(null);
  const inflight = new Set<string>();
  const completed = new Map<string, number>();
  const selectionPlanCache = createPlanCache();
  let scheduled = false;
  let forceNext = false;
  let latestRequest = 0;

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

      const fresh = paths.every((path) => isSelectionFresh(store, path, metadata));
      const forced = forceNext;
      forceNext = false;
      if (!forced && policy === "cache-first" && fresh) {
        return;
      }

      const operation = planCached(selectionPlanCache, paths, "query", metadata);
      const key = operationKey(operation);
      const completedFresh = !forced && isCompletedFresh(completed, key);
      if (policy === "cache-first" && completedFresh) {
        return;
      }
      if (
        completedFresh &&
        ((policy === "cache-and-network" && fresh) || policy === "network-only")
      ) {
        return;
      }
      if (inflight.has(key)) {
        return;
      }

      inflight.add(key);
      const request = ++latestRequest;
      loading(true);
      error(null);

      fetcher(operation)
        .then((data) => {
          if (request !== latestRequest) {
            return undefined;
          }
          writeOperationResult(store, data, operation.selections, ttl, metadata);
          const freshAfterWrite = paths.every((path) => isSelectionFresh(store, path, metadata));
          // Cache-first only remembers false negatives; fresh paths must refetch if later marked stale.
          if (policy !== "cache-first" || !freshAfterWrite) {
            completed.set(key, expiresAt(ttl));
          } else {
            completed.delete(key);
          }
          return undefined;
        })
        .catch((reason) => {
          if (request !== latestRequest) {
            return;
          }
          error(reason instanceof Error ? reason : new Error(String(reason)));
        })
        .finally(() => {
          inflight.delete(key);
          loading(inflight.size > 0);
        });
    });
  }

  return {
    store,

    mount() {
      return collector.register();
    },

    unmount(reader) {
      collector.unregister(reader);
    },

    begin(reader) {
      collector.begin(reader);
    },

    select(reader, path) {
      collector.select(reader, path);
    },

    commit(reader) {
      collector.commit(reader);
    },

    discard(reader) {
      collector.discard(reader);
    },

    replace(reader, paths) {
      collector.replace(reader, paths);
    },

    loading() {
      return loading();
    },

    error() {
      return error();
    },

    schedule,

    refetch() {
      completed.clear();
      schedule(true);
    },

    invalidate(specs) {
      applyInvalidations(store, specs, metadata);
      completed.clear();
      schedule(true);
    },
  };
}

function isCompletedFresh(completed: Map<string, number>, key: string): boolean {
  const expires = completed.get(key);
  if (expires === undefined) {
    return false;
  }
  if (isExpiresFresh(expires)) {
    return true;
  }
  completed.delete(key);
  return false;
}

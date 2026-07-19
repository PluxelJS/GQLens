import { createSelectionCollector } from "../collector";
import { isSelectionFresh } from "../cache/freshness";
import { writeOperationResult } from "../cache/materialize";
import { expiresAt, isExpiresFresh } from "../cache/store";
import { applyInvalidations } from "../invalidation";
import { createSignal } from "../signal";
import type { GraphDataRuntimeStore, GraphDataStore, QuerySessionConfig } from "../types";
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
  const runtimeStore = store as GraphDataRuntimeStore;
  const policy = options.policy ?? "cache-and-network";
  const ttl = options.ttl ?? 0;
  const schema = options.schema;
  const collector = createSelectionCollector();
  const loading = createSignal(false);
  const error = createSignal<Error | null>(null);
  const inflight = new Set<string>();
  const completed = new Map<string, number>();
  const controllers = new Map<number, AbortController>();
  const selectionPlanCache = createPlanCache();
  let scheduled = false;
  let forceNext = false;
  let latestRequest = 0;
  let disposed = false;

  function schedule(force = false): void {
    if (disposed) {
      return;
    }
    forceNext ||= force;
    if (scheduled) {
      return;
    }
    scheduled = true;

    queueMicrotask(() => {
      scheduled = false;
      const paths = collector.snapshot();
      if (paths.length === 0) {
        latestRequest += 1;
        abortInflight("GQLens query has no active readers");
        loading(false);
        return;
      }

      const fresh = paths.every((path) => isSelectionFresh(runtimeStore, path, schema));
      const forced = forceNext;
      forceNext = false;
      if (!forced && policy === "cache-first" && fresh) {
        return;
      }

      const operation = planCached(selectionPlanCache, paths, "query", schema);
      const key = operationKey(operation);
      const completedFresh =
        policy !== "network-only" && !forced && isCompletedFresh(completed, key);
      if (policy === "cache-first" && completedFresh) {
        return;
      }
      if (policy === "cache-and-network" && completedFresh && fresh) {
        return;
      }
      if (inflight.has(key)) {
        return;
      }

      inflight.add(key);
      const request = ++latestRequest;
      abortInflight("GQLens query was superseded");
      const controller = new AbortController();
      controllers.set(request, controller);
      loading(true);
      error(null);

      fetcher(operation, { signal: controller.signal })
        .then((data) => {
          if (request !== latestRequest) {
            return undefined;
          }
          writeOperationResult(runtimeStore, data, operation.selections, ttl, schema);
          const freshAfterWrite = paths.every((path) =>
            isSelectionFresh(runtimeStore, path, schema),
          );
          // Cache-first only remembers false negatives; fresh paths must refetch if later marked stale.
          if (policy === "network-only") {
            completed.delete(key);
          } else if (policy !== "cache-first" || !freshAfterWrite) {
            completed.set(key, expiresAt(ttl));
          } else {
            completed.delete(key);
          }
          return undefined;
        })
        .catch((reason) => {
          if (request !== latestRequest || controller.signal.aborted) {
            return;
          }
          error(reason instanceof Error ? reason : new Error(String(reason)));
        })
        .finally(() => {
          controllers.delete(request);
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
      schedule();
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
      applyInvalidations(store, specs, schema);
      completed.clear();
      schedule(true);
    },

    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      latestRequest += 1;
      collector.reset();
      abortInflight("GQLens query session was disposed");
      loading(false);
    },
  };

  function abortInflight(message: string): void {
    for (const controller of controllers.values()) {
      controller.abort(new Error(message));
    }
    controllers.clear();
  }
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

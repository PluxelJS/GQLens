import { createSelectionCollector } from "../collector";
import { writeOperationResult } from "../cache/materialize";
import { applyInvalidations } from "../invalidation";
import { createSignal } from "../signal";
import type { GraphDataStore, QuerySessionConfig } from "../types";
import type { LiveSubscriber } from "../transport";
import { createPlanCache, operationKey, planCached } from "./operation-cache";
import type { QuerySession } from "./types";

/** Runtime dependencies and execution settings for a live query session. */
export interface LiveQuerySessionOptions extends QuerySessionConfig {
  /** Graph data store updated every time the live transport emits data. */
  readonly store: GraphDataStore;
  /** Transport subscription function used to receive live GraphQL payloads. */
  readonly subscriber: LiveSubscriber;
}

export function createLiveQuerySession(options: LiveQuerySessionOptions): QuerySession {
  const { store, subscriber } = options;
  const ttl = options.ttl ?? 0;
  const metadata = options.metadata;
  const collector = createSelectionCollector();
  const loading = createSignal(false);
  const error = createSignal<Error | null>(null);
  const selectionPlanCache = createPlanCache();
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

      const operation = planCached(selectionPlanCache, paths, "query", metadata);
      const key = operationKey(operation);
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
        unsubscribe = subscriber(
          operation,
          (data) => {
            writeOperationResult(store, data, operation.selections, ttl, metadata);
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
      schedule(true);
    },

    invalidate(specs) {
      applyInvalidations(store, specs, metadata);
      schedule(true);
    },
  };
}

import { createSignal as createSolidSignal, getOwner, onCleanup } from "solid-js";
import {
  bindSelection,
  createFetchTransport,
  createLiveQuerySession,
  createLiveTransport,
  createMutationRunner,
  createGraphDataStore,
  createQuerySession,
  watchSignal,
  type AlienSignalReader,
  type Fetcher,
  type LiveSubscriber,
  type MutationOptions,
  type MutationSource,
  type GraphDataStore,
  type PreparedSelection,
  type QuerySession,
  type QuerySessionConfig,
  type SelectionStep,
} from "@gqlens/core";

/** Live transport wiring used by createLiveQuery. */
export interface LiveConfig {
  /**
   * Custom live subscriber.
   *
   * @default undefined
   * A WebSocket live transport is created from endpoint when omitted.
   */
  readonly subscriber?: LiveSubscriber | undefined;
  /**
   * Cleanup function for a custom live subscriber. Ignored for the built-in WebSocket transport.
   *
   * @default undefined
   */
  readonly close?: (() => void) | undefined;
}

/** Query runtime options for Solid entrypoints. */
export interface QueryConfig extends QuerySessionConfig {
  /**
   * GraphQL HTTP endpoint used when fetcher is not provided. Also seeds the built-in live transport.
   *
   * @default "/graphql"
   */
  readonly endpoint?: string | undefined;
  /**
   * Graph data store instance.
   *
   * @default undefined
   * A call-local store is created when omitted.
   */
  readonly store?: GraphDataStore | undefined;
  /**
   * Custom query fetcher. Takes precedence over endpoint for HTTP operations.
   *
   * @default undefined
   * The endpoint-backed HTTP fetcher is used when omitted.
   */
  readonly fetcher?: Fetcher | undefined;
  /**
   * Live-query transport configuration.
   *
   * @default undefined
   * The endpoint-backed WebSocket live transport is used when omitted.
   */
  readonly live?: LiveConfig | undefined;
}

export interface SolidSessionState {
  readonly loading: () => boolean;
  readonly error: () => Error | null;
  readonly session: QuerySession;
  readonly store: GraphDataStore;
  demand(root: string, steps: readonly SelectionStep[]): void;
  read<T>(sig: AlienSignalReader<T>): T;
}

/** Mutation runtime options for createMutation. */
export interface MutationConfig {
  /**
   * GraphQL HTTP endpoint used when fetcher is not provided.
   *
   * @default "/graphql"
   */
  readonly endpoint?: string | undefined;
  /**
   * Graph data store updated by mutation results and optimistic writes.
   *
   * @default undefined
   */
  readonly store?: GraphDataStore | undefined;
  /**
   * Custom mutation fetcher. Takes precedence over endpoint.
   *
   * @default undefined
   * The endpoint-backed HTTP fetcher is used when omitted.
   */
  readonly fetcher?: Fetcher | undefined;
}

const defaultEndpoint = "/graphql";

export function createQuery(config: QueryConfig = {}): SolidSessionState {
  const store = config.store ?? createGraphDataStore();
  const fetcher = config.fetcher ?? createFetchTransport(config.endpoint ?? defaultEndpoint);
  const session = createQuerySession({ store, fetcher, ...querySessionConfig(config) });
  const reader = createSolidReaderScope(session);

  if (getOwner()) {
    onCleanup(() => {
      reader.dispose();
    });
  }

  queueMicrotask(() => session.schedule());

  return {
    loading: () => reader.read(session.loading),
    error: () => reader.read(session.error),
    session,
    store,
    demand: reader.demand,
    read: reader.read,
  };
}

export function createLiveQuery(config: QueryConfig = {}): SolidSessionState {
  const store = config.store ?? createGraphDataStore();
  const [subscribe, close] = resolveLiveTransport(config);
  const session = createLiveQuerySession({
    store,
    subscriber: subscribe,
    ...querySessionConfig(config),
  });
  const reader = createSolidReaderScope(session);

  if (getOwner()) {
    onCleanup(() => {
      reader.dispose();
      close();
    });
  }

  queueMicrotask(() => session.schedule());

  return {
    loading: () => reader.read(session.loading),
    error: () => reader.read(session.error),
    session,
    store,
    demand: reader.demand,
    read: reader.read,
  };
}

export function createPreparedQuery(
  selection: PreparedSelection,
  variables: Readonly<Record<string, unknown>>,
  config: QueryConfig = {},
): SolidSessionState {
  const state = createQuery(config);
  for (const path of bindSelection(selection, variables)) {
    state.demand(path.root, path.steps);
  }
  return state;
}

function resolveLiveTransport(config: QueryConfig): readonly [LiveSubscriber, () => void] {
  if (config.live?.subscriber) {
    return [config.live.subscriber, config.live.close ?? noop];
  }
  return createLiveTransport(config.endpoint ?? defaultEndpoint);
}

const noop = (): void => undefined;

function querySessionConfig(config: QueryConfig): QuerySessionConfig {
  return {
    policy: config.policy ?? "cache-and-network",
    ttl: config.ttl ?? 0,
    metadata: config.metadata,
  };
}

export function createMutation<TInput extends Record<string, unknown>, TData>(
  mutation: MutationSource<TInput, TData>,
  config: MutationConfig = {},
): (input: TInput & MutationOptions) => Promise<TData> {
  const store = config.store ?? createGraphDataStore();
  const fetcher = config.fetcher ?? createFetchTransport(config.endpoint ?? defaultEndpoint);
  return createMutationRunner({ store, mutation, fetcher });
}

interface SolidReaderScope {
  demand(root: string, steps: readonly SelectionStep[]): void;
  read<T>(sig: AlienSignalReader<T>): T;
  dispose(): void;
}

function createSolidReaderScope(session: QuerySession): SolidReaderScope {
  const reader = session.mount();
  const watched = new Map<
    AlienSignalReader,
    { readonly track: () => number; readonly stop: () => void }
  >();

  return {
    demand(root: string, steps: readonly SelectionStep[]): void {
      session.select(reader, { root, steps });
      session.schedule();
    },

    read<T>(sig: AlienSignalReader<T>): T {
      let watchedSignal = watched.get(sig);
      if (!watchedSignal) {
        const [track, bump] = createSolidSignal(0);
        watchedSignal = {
          track,
          stop: watchSignal(sig, () => bump((value) => value + 1)),
        };
        watched.set(sig, watchedSignal);
      }
      watchedSignal.track();
      return sig();
    },

    dispose(): void {
      for (const item of watched.values()) {
        item.stop();
      }
      watched.clear();
      session.unmount(reader);
    },
  };
}

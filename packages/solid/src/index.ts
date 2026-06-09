import { createSignal as createSolidSignal, getOwner, onCleanup } from "solid-js";
import {
  bindSelection,
  createFetchTransport,
  createLiveQuerySession,
  createLiveTransport,
  createMutationRunner,
  createNormalizedCache,
  createQuerySession,
  watchSignal,
  type AlienSignalReader,
  type Fetcher,
  type LiveSubscriber,
  type MutationOptions,
  type MutationSource,
  type NormalizedCache,
  type PreparedSelection,
  type QuerySession,
  type QuerySessionConfig,
  type SelectionStep,
} from "@gqlens/core";

/** Live transport wiring used by createLiveQuery. */
export interface LiveConfig {
  /** Custom live subscriber. When omitted, a WebSocket live transport is created from endpoint. */
  readonly subscriber?: LiveSubscriber | undefined;
  /** Cleanup function for a custom live subscriber. Ignored for the built-in WebSocket transport. */
  readonly close?: (() => void) | undefined;
}

/** Query runtime options for Solid entrypoints. */
export interface QueryConfig extends QuerySessionConfig {
  /** GraphQL HTTP endpoint used when fetcher is not provided. Also seeds the built-in live transport. */
  readonly endpoint?: string | undefined;
  /** Normalized cache instance. A call-local cache is created when omitted. */
  readonly cache?: NormalizedCache | undefined;
  /** Custom query fetcher. Takes precedence over endpoint for HTTP operations. */
  readonly fetcher?: Fetcher | undefined;
  /** Live-query transport configuration. */
  readonly live?: LiveConfig | undefined;
}

export interface SolidSessionState {
  readonly loading: () => boolean;
  readonly error: () => Error | null;
  readonly session: QuerySession;
  readonly cache: NormalizedCache;
  demand(root: string, steps: readonly SelectionStep[]): void;
  read<T>(sig: AlienSignalReader<T>): T;
}

/** Mutation runtime options for createMutation. */
export interface MutationConfig {
  /** GraphQL HTTP endpoint used when fetcher is not provided. */
  readonly endpoint?: string | undefined;
  /** Normalized cache updated by mutation results and optimistic writes. */
  readonly cache?: NormalizedCache | undefined;
  /** Custom mutation fetcher. Takes precedence over endpoint. */
  readonly fetcher?: Fetcher | undefined;
}

const defaultEndpoint = "/graphql";

export function createQuery(config: QueryConfig = {}): SolidSessionState {
  const cache = config.cache ?? createNormalizedCache();
  const fetcher = config.fetcher ?? createFetchTransport(config.endpoint ?? defaultEndpoint);
  const session = createQuerySession({ cache, fetcher, ...querySessionConfig(config) });
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
    cache,
    demand: reader.demand,
    read: reader.read,
  };
}

export function createLiveQuery(config: QueryConfig = {}): SolidSessionState {
  const cache = config.cache ?? createNormalizedCache();
  const [subscribe, close] = resolveLiveTransport(config);
  const session = createLiveQuerySession({
    cache,
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
    cache,
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
  const cache = config.cache ?? createNormalizedCache();
  const fetcher = config.fetcher ?? createFetchTransport(config.endpoint ?? defaultEndpoint);
  return createMutationRunner({ cache, mutation, fetcher });
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

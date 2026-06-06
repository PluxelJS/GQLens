import { createSignal as createSolidSignal, getOwner, onCleanup } from "solid-js";
import {
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
  type QuerySession,
  type QuerySessionConfig,
  type SelectionStep,
} from "@gqlens/core";

export interface QueryConfig extends Partial<QuerySessionConfig> {
  readonly endpoint?: string | undefined;
  readonly cache?: NormalizedCache | undefined;
  readonly fetcher?: Fetcher | undefined;
  readonly liveSubscriber?: LiveSubscriber | undefined;
  readonly closeLive?: (() => void) | undefined;
}

export interface SolidSessionState {
  readonly loading: () => boolean;
  readonly error: () => Error | null;
  readonly session: QuerySession;
  readonly cache: NormalizedCache;
  demand(root: string, steps: readonly SelectionStep[]): void;
  read<T>(sig: AlienSignalReader<T>): T;
}

const defaultEndpoint = "/graphql";

export function createQuery(config: QueryConfig = {}): SolidSessionState {
  const cache = config.cache ?? createNormalizedCache();
  const fetcher = config.fetcher ?? createFetchTransport(config.endpoint ?? defaultEndpoint);
  const session = createQuerySession(cache, fetcher, {
    policy: config.policy ?? "cache-and-network",
    ttl: config.ttl ?? 0,
    metadata: config.metadata,
  });
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
  const session = createLiveQuerySession(cache, subscribe, {
    policy: config.policy ?? "cache-and-network",
    ttl: config.ttl ?? 0,
    metadata: config.metadata,
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

function resolveLiveTransport(config: QueryConfig): readonly [LiveSubscriber, () => void] {
  if (config.liveSubscriber) {
    return [config.liveSubscriber, config.closeLive ?? noop];
  }
  return createLiveTransport(config.endpoint ?? defaultEndpoint);
}

const noop = (): void => undefined;

export function createMutation<TInput extends Record<string, unknown>, TData>(
  mutation: MutationSource<TInput, TData>,
  cache: NormalizedCache = createNormalizedCache(),
  fetcher: Fetcher = createFetchTransport(defaultEndpoint),
): (input: TInput & MutationOptions) => Promise<TData> {
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

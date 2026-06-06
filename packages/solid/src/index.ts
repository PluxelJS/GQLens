import { createSignal as createSolidSignal, getOwner, onCleanup } from "solid-js";
import {
  createFetchTransport,
  createLiveQuerySession,
  createLiveTransport,
  createNormalizedCache,
  createQuerySession,
  applyInvalidations,
  isInvalidationSpec,
  watchSignal,
  type AlienSignalReader,
  type Fetcher,
  type InvalidationInput,
  type LiveSubscriber,
  type MutationOperation,
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

interface MutationOptions {
  readonly optimistic?: ((cache: NormalizedCache) => void) | undefined;
  readonly invalidates?: readonly InvalidationInput[] | undefined;
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
  const mutationFn = mutationFunction(mutation, fetcher);
  return async (input: TInput & MutationOptions): Promise<TData> => {
    const snapshots = input.optimistic
      ? snapshotFields(cache, input.invalidates ?? [])
      : new Map<string, Record<string, unknown>>();
    input.optimistic?.(cache);

    try {
      const data = await mutationFn(input);
      if (input.invalidates && input.invalidates.length > 0) {
        applyInvalidations(cache, input.invalidates);
      }
      normalizeMutationResult(cache, data);
      return data;
    } catch (error) {
      rollback(cache, input.invalidates ?? [], snapshots);
      throw error;
    }
  };
}

function normalizeMutationResult(cache: NormalizedCache, data: unknown): void {
  if (isEntityObject(data)) {
    cache.normalize({ mutation: data });
    return;
  }
  cache.normalize((data ?? {}) as Record<string, unknown>);
}

function isEntityObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "__typename" in value && "id" in value;
}

type MutationSource<TInput extends Record<string, unknown>, TData> =
  | ((input: TInput) => Promise<TData>)
  | MutationOperation<TInput, TData>;

function mutationFunction<TInput extends Record<string, unknown>, TData>(
  mutation: MutationSource<TInput, TData>,
  fetcher: Fetcher,
): (input: TInput) => Promise<TData> {
  if (typeof mutation === "function") {
    return mutation;
  }

  return async (input: TInput): Promise<TData> => {
    const data = (await fetcher({
      query: mutation.query,
      variables: mutation.variables(input),
      operationName: mutation.operationName,
      selections: [],
    })) as Record<string, unknown>;
    return (data[mutation.operationName] ?? data) as TData;
  };
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

function snapshotFields(
  cache: NormalizedCache,
  specs: readonly InvalidationInput[],
): Map<string, Record<string, unknown>> {
  const snapshots = new Map<string, Record<string, unknown>>();
  for (const spec of specs) {
    if (!isInvalidationSpec(spec)) {
      continue;
    }
    if (!spec.keys || spec.keys.length === 0) {
      continue;
    }
    const ref = cache.entity(spec.type, spec.id);
    const values: Record<string, unknown> = {};
    for (const key of spec.keys) {
      values[key] = cache.field(ref, key).sig();
    }
    snapshots.set(`${spec.type}:${spec.id}`, values);
  }
  return snapshots;
}

function rollback(
  cache: NormalizedCache,
  specs: readonly InvalidationInput[],
  snapshots: ReadonlyMap<string, Record<string, unknown>>,
): void {
  for (const spec of specs) {
    if (!isInvalidationSpec(spec)) {
      applyInvalidations(cache, [spec]);
      continue;
    }
    const ref = cache.entity(spec.type, spec.id);
    const snapshot = snapshots.get(`${spec.type}:${spec.id}`);
    if (snapshot && spec.keys) {
      for (const key of spec.keys) {
        cache.field(ref, key).sig(snapshot[key]);
      }
    } else {
      cache.invalidate(ref, spec.keys);
    }
  }
}

import {
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import {
  createFetchTransport,
  createLiveTransport,
  createNormalizedCache,
  createQuerySession,
  selectionKey,
  watchSignal,
  type AlienSignalReader,
  type Fetcher,
  type InvalidationSpec,
  type MutationOperation,
  type NormalizedCache,
  type QuerySession,
  type QuerySessionConfig,
  type PlannerMetadata,
  type SelectionPath,
  type SelectionStep,
} from "@gqlens/core";

export interface GQLensConfig {
  readonly endpoint: string;
  readonly cache?: NormalizedCache | undefined;
  readonly fetcher?: Fetcher | undefined;
  readonly defaultPolicy?: QuerySessionConfig["policy"] | undefined;
  readonly defaultTTL?: number | undefined;
}

export interface SessionState {
  readonly loading: boolean;
  readonly error: Error | null;
  readonly session: QuerySession;
  readonly cache: NormalizedCache;
  demand(root: string, steps: readonly SelectionStep[]): void;
  read<T>(sig: AlienSignalReader<T>): T;
}

interface GQLensRuntime {
  readonly cache: NormalizedCache;
  readonly defaultPolicy: QuerySessionConfig["policy"] | undefined;
  readonly defaultTTL: number | undefined;
  readonly fetcher: Fetcher;
  session(config: QuerySessionConfig): QuerySession;
  liveSession(config: QuerySessionConfig): QuerySession;
}

const ConfigContext = createContext<GQLensRuntime | null>(null);
let nextMetadataId = 0;
const metadataIds = new WeakMap<PlannerMetadata, number>();

export function GQLensProvider(props: {
  readonly config: GQLensConfig;
  readonly children: ReactNode;
}): ReactElement {
  const cache = useMemo(() => props.config.cache ?? createNormalizedCache(), [props.config.cache]);
  const fetcher = useMemo(
    () => props.config.fetcher ?? createFetchTransport(props.config.endpoint),
    [props.config.fetcher, props.config.endpoint],
  );
  const [subscribe, closeLive] = useMemo(
    () => createLiveTransport(props.config.endpoint),
    [props.config.endpoint],
  );
  const liveFetcher = useMemo<Fetcher>(
    () => (op) => new Promise((resolve) => subscribe(op, resolve)),
    [subscribe],
  );
  const runtime = useMemo<GQLensRuntime>(() => {
    const sessions = new Map<string, QuerySession>();
    const liveSessions = new Map<string, QuerySession>();
    return {
      cache,
      defaultPolicy: props.config.defaultPolicy,
      defaultTTL: props.config.defaultTTL,
      fetcher,

      session(config: QuerySessionConfig): QuerySession {
        return getOrCreateSession(sessions, cache, fetcher, config);
      },

      liveSession(config: QuerySessionConfig): QuerySession {
        return getOrCreateSession(liveSessions, cache, liveFetcher, config);
      },
    };
  }, [cache, fetcher, liveFetcher, props.config.defaultPolicy, props.config.defaultTTL]);

  useEffect(() => closeLive, [closeLive]);

  return createElement(ConfigContext.Provider, { value: runtime }, props.children);
}

export function useGQLensSession(config?: Partial<QuerySessionConfig>): SessionState {
  const global = useConfig();
  const policy = config?.policy ?? global.defaultPolicy ?? "cache-and-network";
  const ttl = config?.ttl ?? global.defaultTTL ?? 0;
  const metadata = config?.metadata;
  const session = useMemo(
    () => global.session({ policy, ttl, metadata }),
    [global, metadata, policy, ttl],
  );

  const reader = useRenderTracking(session);

  return {
    get loading() {
      return session.loading();
    },
    get error() {
      return session.error();
    },
    session,
    cache: global.cache,
    demand: reader.demand,
    read: reader.read,
  };
}

export function useLiveGQLensSession(config?: Partial<QuerySessionConfig>): SessionState {
  const global = useConfig();
  const policy = config?.policy ?? global.defaultPolicy ?? "cache-and-network";
  const ttl = config?.ttl ?? global.defaultTTL ?? 0;
  const metadata = config?.metadata;
  const session = useMemo(
    () => global.liveSession({ policy, ttl, metadata }),
    [global, metadata, policy, ttl],
  );

  const reader = useRenderTracking(session);

  return {
    get loading() {
      return session.loading();
    },
    get error() {
      return session.error();
    },
    session,
    cache: global.cache,
    demand: reader.demand,
    read: reader.read,
  };
}

export const useQuery: (config?: Partial<QuerySessionConfig>) => SessionState = useGQLensSession;
export const useLiveQuery: (config?: Partial<QuerySessionConfig>) => SessionState =
  useLiveGQLensSession;

export function useMutation<TInput extends Record<string, unknown>, TData>(
  mutation: MutationSource<TInput, TData>,
): (input: TInput & MutationOptions) => Promise<TData> {
  const global = useConfig();
  const mutationFn = useMemo(
    () => mutationFunction(mutation, global.fetcher),
    [global.fetcher, mutation],
  );

  return useCallback(
    async (input: TInput & MutationOptions): Promise<TData> =>
      runMutation(global.cache, mutationFn, input),
    [global.cache, mutationFn],
  );
}

function useConfig(): GQLensRuntime {
  const config = useContext(ConfigContext);
  if (!config) {
    throw new Error("GQLens hooks must be used within <GQLensProvider>");
  }
  return config;
}

function getOrCreateSession(
  sessions: Map<string, QuerySession>,
  cache: NormalizedCache,
  fetcher: Fetcher,
  config: QuerySessionConfig,
): QuerySession {
  const key = sessionKey(config);
  const existing = sessions.get(key);
  if (existing) {
    return existing;
  }

  const session = createQuerySession(cache, fetcher, config);
  sessions.set(key, session);
  return session;
}

function sessionKey(config: QuerySessionConfig): string {
  return `${config.policy ?? ""}:${config.ttl ?? ""}:${metadataId(config.metadata)}`;
}

function metadataId(metadata: PlannerMetadata | undefined): number {
  if (!metadata) {
    return 0;
  }
  const existing = metadataIds.get(metadata);
  if (existing) {
    return existing;
  }
  const id = ++nextMetadataId;
  metadataIds.set(metadata, id);
  return id;
}

interface ReaderScope {
  demand(root: string, steps: readonly SelectionStep[]): void;
  read<T>(sig: AlienSignalReader<T>): T;
}

function useRenderTracking(session: QuerySession): ReaderScope {
  const reader = useMemo(() => session.mount(), [session]);
  const signalsRef = useRef<Set<AlienSignalReader>>(new Set());
  const pathsRef = useRef<SelectionPath[]>([]);
  const [, forceRender] = useReducer((value: number) => value + 1, 0);

  signalsRef.current = new Set<AlienSignalReader>();
  pathsRef.current = [];

  useLayoutEffect(() => {
    session.replace(reader, pathsRef.current);
    session.schedule();
    const unsubscribers = [...signalsRef.current].map((sig) => watchSignal(sig, forceRender));
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  });

  useEffect(
    () => () => {
      session.unmount(reader);
    },
    [reader, session],
  );

  return useMemo(
    () => ({
      demand(root: string, steps: readonly SelectionStep[]): void {
        addSelection(pathsRef.current, { root, steps });
      },
      read<T>(sig: AlienSignalReader<T>): T {
        signalsRef.current.add(sig);
        return sig();
      },
    }),
    [reader, session],
  );
}

function addSelection(paths: SelectionPath[], path: SelectionPath): void {
  const key = selectionKey(path);
  if (!paths.some((item) => selectionKey(item) === key)) {
    paths.push(path);
  }
}

interface MutationOptions {
  readonly optimistic?: ((cache: NormalizedCache) => void) | undefined;
  readonly invalidates?: readonly InvalidationSpec[] | undefined;
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

async function runMutation<TInput extends Record<string, unknown>, TData>(
  cache: NormalizedCache,
  mutationFn: (input: TInput) => Promise<TData>,
  input: TInput & MutationOptions,
): Promise<TData> {
  const snapshots = input.optimistic
    ? snapshotFields(cache, input.invalidates ?? [])
    : new Map<string, Record<string, unknown>>();
  input.optimistic?.(cache);

  try {
    const data = await mutationFn(input);
    normalizeMutationResult(cache, data);
    return data;
  } catch (error) {
    rollback(cache, input.invalidates ?? [], snapshots);
    throw error;
  }
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

function snapshotFields(
  cache: NormalizedCache,
  specs: readonly InvalidationSpec[],
): Map<string, Record<string, unknown>> {
  const snapshots = new Map<string, Record<string, unknown>>();
  for (const spec of specs) {
    if (!spec.keys || spec.keys.length === 0) {
      continue;
    }
    const ref = cache.entity(spec.type, spec.id);
    const fields: Record<string, unknown> = {};
    for (const key of spec.keys) {
      fields[key] = cache.field(ref, key).sig();
    }
    snapshots.set(`${spec.type}:${spec.id}`, fields);
  }
  return snapshots;
}

function rollback(
  cache: NormalizedCache,
  specs: readonly InvalidationSpec[],
  snapshots: ReadonlyMap<string, Record<string, unknown>>,
): void {
  for (const spec of specs) {
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

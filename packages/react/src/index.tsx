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
  createLiveQuerySession,
  createLiveTransport,
  createMutationRunner,
  createNormalizedCache,
  createQuerySession,
  applyInvalidations,
  selectionKey,
  watchSignal,
  type AlienSignalReader,
  type Fetcher,
  type InvalidationInput,
  type LiveSubscriber,
  type MutationOptions,
  type MutationSource,
  type NormalizedCache,
  type QuerySession,
  type QuerySessionConfig,
  type PlannerMetadata,
  type SelectionPath,
  type SelectionStep,
} from "@gqlens/core";

export interface GQLensConfig {
  readonly endpoint?: string | undefined;
  readonly cache?: NormalizedCache | undefined;
  readonly fetcher?: Fetcher | undefined;
  readonly liveSubscriber?: LiveSubscriber | undefined;
  readonly closeLive?: (() => void) | undefined;
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
  invalidate(specs: readonly InvalidationInput[]): void;
}

const ConfigContext = createContext<GQLensRuntime | null>(null);
let nextMetadataId = 0;
const metadataIds = new WeakMap<PlannerMetadata, number>();
const defaultEndpoint = "/graphql";

export function GQLensProvider(props: {
  readonly config: GQLensConfig;
  readonly children: ReactNode;
}): ReactElement {
  const cache = useMemo(() => props.config.cache ?? createNormalizedCache(), [props.config.cache]);
  const fetcher = useMemo(
    () => props.config.fetcher ?? createFetchTransport(props.config.endpoint ?? defaultEndpoint),
    [props.config.fetcher, props.config.endpoint],
  );
  const [subscribe, closeLive] = useLiveTransportConfig(props.config);
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
        return getOrCreateLiveSession(liveSessions, cache, subscribe, config);
      },

      invalidate(specs: readonly InvalidationInput[]): void {
        applyInvalidations(cache, specs);
        for (const session of sessions.values()) {
          session.refetch();
        }
        for (const session of liveSessions.values()) {
          session.refetch();
        }
      },
    };
  }, [cache, fetcher, props.config.defaultPolicy, props.config.defaultTTL, subscribe]);

  useEffect(() => closeLive, [closeLive]);

  return createElement(ConfigContext.Provider, { value: runtime }, props.children);
}

function useLiveTransportConfig(config: GQLensConfig): readonly [LiveSubscriber, () => void] {
  return useMemo(() => {
    if (config.liveSubscriber) {
      return [config.liveSubscriber, config.closeLive ?? noop] as const;
    }
    return createLiveTransport(config.endpoint ?? defaultEndpoint);
  }, [config.closeLive, config.endpoint, config.liveSubscriber]);
}

const noop = (): void => undefined;

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
      return reader.read(session.loading);
    },
    get error() {
      return reader.read(session.error);
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
      return reader.read(session.loading);
    },
    get error() {
      return reader.read(session.error);
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
  const runMutation = useMemo(
    () =>
      createMutationRunner({
        cache: global.cache,
        mutation,
        fetcher: global.fetcher,
        invalidate: global.invalidate,
      }),
    [global.cache, global.fetcher, global.invalidate, mutation],
  );

  return useCallback(
    async (input: TInput & MutationOptions): Promise<TData> => runMutation(input),
    [runMutation],
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

function getOrCreateLiveSession(
  sessions: Map<string, QuerySession>,
  cache: NormalizedCache,
  subscribe: Parameters<typeof createLiveQuerySession>[1],
  config: QuerySessionConfig,
): QuerySession {
  const key = sessionKey(config);
  const existing = sessions.get(key);
  if (existing) {
    return existing;
  }

  const session = createLiveQuerySession(cache, subscribe, config);
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

import {
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  applyInvalidations,
  bindSelection,
  createFetchTransport,
  createLiveQuerySession,
  createLiveTransport,
  createMutationRunner,
  createNormalizedCache,
  createQuerySession,
  type AlienSignalReader,
  type CacheInvalidation,
  type Fetcher,
  type LiveSubscriber,
  type MutationOptions,
  type MutationSource,
  type NormalizedCache,
  type PlannerMetadata,
  type QuerySession,
  type QuerySessionConfig,
  type QueryDefaults,
  type PreparedSelection,
  type SelectionStep,
} from "@gqlens/core";
import { useRenderTracking } from "./render-tracking";
import { createSessionRegistry, type SessionLease, type SessionRequest } from "./session-registry";

/** Live transport wiring used by useLiveQuery. */
export interface LiveConfig {
  /** Custom live subscriber. When omitted, a WebSocket live transport is created from endpoint. */
  readonly subscriber?: LiveSubscriber | undefined;
  /** Cleanup function for a custom live subscriber. Ignored for the built-in WebSocket transport. */
  readonly close?: (() => void) | undefined;
}

/** Provider-level runtime configuration shared by all GQLens React hooks. */
export interface GQLensConfig {
  /** GraphQL HTTP endpoint used when fetcher is not provided. Also seeds the built-in live transport. */
  readonly endpoint?: string | undefined;
  /** Normalized cache instance. A provider-local cache is created when omitted. */
  readonly cache?: NormalizedCache | undefined;
  /** Custom query/mutation fetcher. Takes precedence over endpoint for HTTP operations. */
  readonly fetcher?: Fetcher | undefined;
  /** Live-query transport configuration. */
  readonly live?: LiveConfig | undefined;
  /** Default query behavior for useQuery and useLiveQuery. */
  readonly query?: QueryDefaults | undefined;
}

/** Hook-level query options. */
export interface QueryConfig extends QuerySessionConfig {
  /** Share a session between hooks with the same scope and query options. Omit for an isolated hook session. */
  readonly scope?: string | undefined;
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
  readonly queryDefaults: QueryDefaults;
  readonly fetcher: Fetcher;
  session(config: SessionRequest): SessionLease;
  liveSession(config: SessionRequest): SessionLease;
  invalidate(specs: readonly CacheInvalidation[], metadata?: PlannerMetadata): void;
}

const ConfigContext = createContext<GQLensRuntime | null>(null);
let nextLocalScopeId = 0;
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
    const sessions = createSessionRegistry((config) =>
      createQuerySession({ cache, fetcher, ...config }),
    );
    const liveSessions = createSessionRegistry((config) =>
      createLiveQuerySession({ cache, subscriber: subscribe, ...config }),
    );
    return {
      cache,
      queryDefaults: props.config.query ?? {},
      fetcher,

      session(config: SessionRequest): SessionLease {
        return sessions.acquire(config);
      },

      liveSession(config: SessionRequest): SessionLease {
        return liveSessions.acquire(config);
      },

      invalidate(specs: readonly CacheInvalidation[], metadata?: PlannerMetadata): void {
        applyInvalidations(cache, specs, metadata);
        for (const session of sessions.values()) {
          session.refetch();
        }
        for (const session of liveSessions.values()) {
          session.refetch();
        }
      },
    };
  }, [cache, fetcher, props.config.query, subscribe]);

  useEffect(() => closeLive, [closeLive]);

  return createElement(ConfigContext.Provider, { value: runtime }, props.children);
}

function useLiveTransportConfig(config: GQLensConfig): readonly [LiveSubscriber, () => void] {
  return useMemo(() => {
    if (config.live?.subscriber) {
      return [config.live.subscriber, config.live.close ?? noop] as const;
    }
    return createLiveTransport(config.endpoint ?? defaultEndpoint);
  }, [config.endpoint, config.live]);
}

const noop = (): void => undefined;

export function useGQLensSession(config?: QueryConfig): SessionState {
  return useSessionState("query", config);
}

export function useLiveGQLensSession(config?: QueryConfig): SessionState {
  return useSessionState("live", config);
}

function useSessionState(mode: "query" | "live", config: QueryConfig = {}): SessionState {
  const global = useConfig();
  const policy = config.policy ?? global.queryDefaults.policy ?? "cache-and-network";
  const ttl = config.ttl ?? global.queryDefaults.ttl ?? 0;
  const metadata = config.metadata;
  const scope = useSessionScope(config.scope);
  const lease = useMemo(
    () => (mode === "live" ? global.liveSession : global.session)({ policy, ttl, metadata, scope }),
    [global, metadata, mode, policy, scope, ttl],
  );
  useEffect(() => lease.release, [lease]);

  const reader = useRenderTracking(lease.session);

  return {
    get loading() {
      return reader.read(lease.session.loading);
    },
    get error() {
      return reader.read(lease.session.error);
    },
    session: lease.session,
    cache: global.cache,
    demand: reader.demand,
    read: reader.read,
  };
}

export const useQuery: (config?: QueryConfig) => SessionState = useGQLensSession;
export const useLiveQuery: (config?: QueryConfig) => SessionState = useLiveGQLensSession;

export function usePreparedQuery(
  selection: PreparedSelection,
  variables: Readonly<Record<string, unknown>>,
  config?: QueryConfig,
): SessionState {
  const state = useGQLensSession(config);
  const paths = useMemo(() => bindSelection(selection, variables), [selection, variables]);
  for (const path of paths) {
    state.demand(path.root, path.steps);
  }
  return state;
}

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

function useSessionScope(scope: string | undefined): string {
  const localScope = useRef<string | null>(null);
  if (scope !== undefined) {
    return `shared:${scope}`;
  }
  if (!localScope.current) {
    localScope.current = `local:${++nextLocalScopeId}`;
  }
  return localScope.current;
}

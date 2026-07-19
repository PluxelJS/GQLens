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
  GQLensError,
  createLiveQuerySession,
  createLiveTransport,
  createMutationRunner,
  createGraphDataStore,
  createQuerySession,
  type AlienSignalReader,
  type GraphDataInvalidation,
  type Fetcher,
  type LiveSubscriber,
  type MutationOptions,
  type MutationDefinition,
  type GraphDataStore,
  type GQLensSchemaContract,
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

/** Provider-level runtime configuration shared by all GQLens React hooks. */
export interface GQLensConfig {
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
   * A provider-local store is created when omitted.
   */
  readonly store?: GraphDataStore | undefined;
  /**
   * Custom query/mutation fetcher. Takes precedence over endpoint for HTTP operations.
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
  /**
   * Default query behavior for useQuery and useLiveQuery.
   *
   * @default { policy: "cache-and-network", ttl: 0 }
   */
  readonly query?: QueryDefaults | undefined;
}

/** Hook-level query options. */
export interface QueryConfig extends QuerySessionConfig {
  /**
   * Share a session between hooks with the same scope and query options.
   *
   * @default undefined
   * Omit for an isolated hook session.
   */
  readonly scope?: string | undefined;
}

export interface SessionState {
  readonly loading: boolean;
  readonly error: Error | null;
  readonly session: QuerySession;
  readonly store: GraphDataStore;
  demand(root: string, steps: readonly SelectionStep[]): void;
  read<T>(sig: AlienSignalReader<T>): T;
}

interface GQLensRuntime {
  readonly store: GraphDataStore;
  readonly queryDefaults: QueryDefaults;
  readonly fetcher: Fetcher;
  session(config: SessionRequest): SessionLease;
  liveSession(config: SessionRequest): SessionLease;
  invalidate(specs: readonly GraphDataInvalidation[], schema?: GQLensSchemaContract): void;
}

const ConfigContext = createContext<GQLensRuntime | null>(null);
let nextLocalScopeId = 0;
const defaultEndpoint = "/graphql";

export function GQLensProvider(props: {
  readonly config: GQLensConfig;
  readonly children: ReactNode;
}): ReactElement {
  const store = useMemo(() => props.config.store ?? createGraphDataStore(), [props.config.store]);
  const fetcher = useMemo(
    () => props.config.fetcher ?? createFetchTransport(props.config.endpoint ?? defaultEndpoint),
    [props.config.fetcher, props.config.endpoint],
  );
  const [subscribe, closeLive] = useLiveTransportConfig(props.config);
  const runtime = useMemo<GQLensRuntime>(() => {
    const sessions = createSessionRegistry((config) =>
      createQuerySession({ store, fetcher, ...config }),
    );
    const liveSessions = createSessionRegistry((config) =>
      createLiveQuerySession({ store, subscriber: subscribe, ...config }),
    );
    return {
      store,
      queryDefaults: props.config.query ?? {},
      fetcher,

      session(config: SessionRequest): SessionLease {
        return sessions.acquire(config);
      },

      liveSession(config: SessionRequest): SessionLease {
        return liveSessions.acquire(config);
      },

      invalidate(specs: readonly GraphDataInvalidation[], schema?: GQLensSchemaContract): void {
        applyInvalidations(store, specs, schema);
        for (const session of sessions.values()) {
          session.refetch();
        }
        for (const session of liveSessions.values()) {
          session.refetch();
        }
      },
    };
  }, [store, fetcher, props.config.query, subscribe]);

  useCommittedCleanup(closeLive);

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
  const schema = config.schema;
  const scope = useSessionScope(config.scope);
  const lease = useMemo(
    () => (mode === "live" ? global.liveSession : global.session)({ policy, ttl, schema, scope }),
    [global, mode, policy, schema, scope, ttl],
  );
  useCommittedCleanup(lease.release);

  const reader = useRenderTracking(lease.session);

  return {
    get loading() {
      return reader.read(lease.session.loading);
    },
    get error() {
      return reader.read(lease.session.error);
    },
    session: lease.session,
    store: global.store,
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
  definition: MutationDefinition<TInput, TData>,
): (input: TInput, options?: MutationOptions) => Promise<TData> {
  const global = useConfig();
  const runMutation = useMemo(
    () =>
      createMutationRunner({
        store: global.store,
        definition,
        fetcher: global.fetcher,
        invalidate: global.invalidate,
      }),
    [global.store, global.fetcher, global.invalidate, definition],
  );

  return useCallback(
    async (input: TInput, options?: MutationOptions): Promise<TData> => runMutation(input, options),
    [runMutation],
  );
}

function useConfig(): GQLensRuntime {
  const config = useContext(ConfigContext);
  if (!config) {
    throw new GQLensError({
      code: "PROVIDER_MISSING",
      message: "GQLens hooks must be used within <GQLensProvider>.",
    });
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

/**
 * React StrictMode replays passive effects as setup -> cleanup -> setup without discarding the
 * mounted resource. Defer cleanup by one microtask so an immediate setup of the same resource can
 * renew its lease; replaced resources and genuine unmounts still clean up normally.
 */
function useCommittedCleanup(cleanup: () => void): void {
  const leases = useRef(new Map<() => void, symbol>());
  useEffect(() => {
    const token = Symbol();
    leases.current.set(cleanup, token);
    return () => {
      queueMicrotask(() => {
        if (leases.current.get(cleanup) !== token) {
          return;
        }
        leases.current.delete(cleanup);
        cleanup();
      });
    };
  }, [cleanup]);
}

import type { signal } from "alien-signals";

export type AlienSignal<T = unknown> = ReturnType<typeof signal<T>>;
export type AlienSignalReader<T = unknown> = () => T;

export interface FieldSignal<T = unknown> {
  readonly sig: AlienSignal<T>;
  expires: number;
}

export interface GraphDataRecord {
  readonly value: unknown;
  readonly expires: number;
}

export interface GraphDataRecordMap {
  get(key: string): GraphDataRecord | undefined;
  set(key: string, record: GraphDataRecord): void;
  delete(key: string): boolean;
  clear(): void;
  entries(): Iterable<readonly [string, GraphDataRecord]>;

  onEvict?(listener: (key: string, record: GraphDataRecord) => void): () => void;
}

export interface GraphDataRecords {
  readonly fields: GraphDataRecordMap;
  readonly slots: GraphDataRecordMap;
}

export interface EntityRef {
  readonly type: string;
  readonly id: string;
}

export interface VariablePlaceholder {
  readonly __gqlensVariable: string;
}

export type GraphDataFacet = "value" | "link" | "ids" | "refs";

export type GraphDataOwner =
  | { readonly kind: "root"; readonly root: string }
  | { readonly kind: "entity"; readonly ref: EntityRef };

export interface GraphDataAddress {
  readonly owner: GraphDataOwner;
  readonly path: readonly SelectionStep[];
  readonly facet?: GraphDataFacet | undefined;
}

export type GraphDataPath = readonly SelectionStep[];

export type GraphDataInvalidation =
  | { readonly kind: "address"; readonly address: GraphDataAddress; readonly family?: boolean }
  | { readonly kind: "entity"; readonly ref: EntityRef; readonly paths?: readonly GraphDataPath[] }
  | { readonly kind: "root"; readonly root: string; readonly paths?: readonly GraphDataPath[] }
  | {
      readonly kind: "selection";
      readonly path: SelectionPath;
      readonly metadata?: PlannerMetadata | undefined;
    };

export interface GraphDataWriteOptions {
  /**
   * Freshness lifetime in milliseconds.
   *
   * @default 0
   * A value of 0 means the written record does not expire by TTL.
   */
  readonly ttl?: number | undefined;
}

export interface GraphDataTransaction<T = unknown> {
  readonly result: T;
  rollback(): void;
}

export interface GraphDataStore {
  entry<T = unknown>(address: GraphDataAddress): FieldSignal<T>;
  peek<T = unknown>(address: GraphDataAddress): FieldSignal<T> | undefined;
  read<T = unknown>(address: GraphDataAddress): T | undefined;
  write<T = unknown>(address: GraphDataAddress, value: T, options?: GraphDataWriteOptions): void;
  isFresh(address: GraphDataAddress): boolean;
  invalidate(target: GraphDataInvalidation | readonly GraphDataInvalidation[]): void;
  transaction<T>(run: (store: GraphDataStore) => T): GraphDataTransaction<T>;

  entity(type: string, id: string): EntityRef;
  normalize(data: GraphQLResult, ttl?: number, metadata?: PlannerMetadata): void;
  clear(): void;
}

export interface SelectionPath {
  readonly root: string;
  readonly steps: readonly SelectionStep[];
}

export interface SelectionStep {
  readonly field: string;
  readonly args?: Record<string, unknown> | undefined;
  readonly typeCondition?: string | undefined;
}

/** Cache strategy used when a query session has active selections. */
export type CachePolicy = "cache-first" | "cache-and-network" | "network-only";

/** Default query execution behavior shared by framework adapters. */
export interface QueryDefaults {
  /**
   * How aggressively the session should read from store before fetching.
   *
   * @default "cache-and-network"
   */
  readonly policy?: CachePolicy | undefined;
  /**
   * Freshness lifetime in milliseconds for graph data written by the session.
   *
   * @default 0
   * A value of 0 means session writes do not expire by TTL.
   */
  readonly ttl?: number | undefined;
}

/** Core query-session execution config. Framework-level options live in adapter config types. */
export interface QuerySessionConfig extends QueryDefaults {
  /**
   * Planner metadata generated from the GraphQL schema. Usually injected by generated accessors.
   *
   * @default undefined
   * Schema-agnostic planning and normalization are used when omitted.
   */
  readonly metadata?: PlannerMetadata | undefined;
}

export type GraphQLResult = Record<string, unknown>;

export interface GraphQLOperation {
  readonly query: string;
  readonly variables: Record<string, unknown>;
  readonly operationName: string;
  readonly selections: readonly PlannedSelectionPath[];
}

export interface MutationOperation<TInput extends Record<string, unknown>, TData> {
  readonly operationName: string;
  readonly query: string;
  readonly metadata?: PlannerMetadata | undefined;
  readonly result?: TData | undefined;
  variables(input: TInput): Record<string, unknown>;
}

export interface PlannerMetadata {
  readonly roots?: Readonly<Record<string, PlannerFieldMetadata>> | undefined;
  readonly types?:
    | Readonly<Record<string, Readonly<Record<string, PlannerFieldMetadata>>>>
    | undefined;
}

export interface PlannerFieldMetadata {
  readonly graphQLType?: string | undefined;
  readonly targetObjectKind?: "entity" | "value" | undefined;
  readonly returnsEntity?: boolean | undefined;
  readonly returnsList?: boolean | undefined;
  readonly isAbstract?: boolean | undefined;
  readonly possibleTypes?: readonly string[] | undefined;
  readonly args?: Readonly<Record<string, string>> | undefined;
}

export interface PlannedSelectionPath {
  readonly root: string;
  readonly steps: readonly PlannedSelectionStep[];
}

export interface PlannedSelectionStep extends SelectionStep {
  readonly responseKey?: string | undefined;
}

export interface PreparedSelection {
  readonly paths: readonly SelectionPath[];
  readonly variables: readonly string[];
}

export interface MutationOptions {
  /**
   * Optimistic write callback executed before the mutation request.
   *
   * @default undefined
   */
  readonly optimistic?: ((store: GraphDataStore) => void) | undefined;
  /**
   * Store targets marked stale after a successful mutation.
   *
   * @default []
   */
  readonly invalidates?: readonly GraphDataInvalidation[] | undefined;
}

export type MutationSource<TInput extends Record<string, unknown>, TData> =
  | ((input: TInput) => Promise<TData>)
  | MutationOperation<TInput, TData>;

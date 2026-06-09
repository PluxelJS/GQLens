import type { signal } from "alien-signals";

export type AlienSignal<T = unknown> = ReturnType<typeof signal<T>>;
export type AlienSignalReader<T = unknown> = () => T;

export interface FieldSignal<T = unknown> {
  readonly sig: AlienSignal<T>;
  expires: number;
}

export interface EntityRef {
  readonly type: string;
  readonly id: string;
}

export interface VariablePlaceholder {
  readonly __gqlensVariable: string;
}

export type CacheFacet = "value" | "link" | "ids" | "refs";

export type CacheOwner =
  | { readonly kind: "root"; readonly root: string }
  | { readonly kind: "entity"; readonly ref: EntityRef };

export interface CacheAddress {
  readonly owner: CacheOwner;
  readonly path: readonly SelectionStep[];
  readonly facet?: CacheFacet | undefined;
}

export type CachePath = readonly SelectionStep[];

export type CacheInvalidation =
  | { readonly kind: "address"; readonly address: CacheAddress; readonly family?: boolean }
  | { readonly kind: "entity"; readonly ref: EntityRef; readonly paths?: readonly CachePath[] }
  | { readonly kind: "root"; readonly root: string; readonly paths?: readonly CachePath[] }
  | {
      readonly kind: "selection";
      readonly path: SelectionPath;
      readonly metadata?: PlannerMetadata | undefined;
    };

export interface CacheWriteOptions {
  readonly ttl?: number | undefined;
}

export interface CacheTransaction<T = unknown> {
  readonly result: T;
  rollback(): void;
}

export interface NormalizedCache {
  entry<T = unknown>(address: CacheAddress): FieldSignal<T>;
  peek<T = unknown>(address: CacheAddress): FieldSignal<T> | undefined;
  read<T = unknown>(address: CacheAddress): T | undefined;
  write<T = unknown>(address: CacheAddress, value: T, options?: CacheWriteOptions): void;
  isFresh(address: CacheAddress): boolean;
  invalidate(target: CacheInvalidation | readonly CacheInvalidation[]): void;
  transaction<T>(run: (cache: NormalizedCache) => T): CacheTransaction<T>;

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
  /** How aggressively the session should read from cache before fetching. */
  readonly policy?: CachePolicy | undefined;
  /** Freshness lifetime in milliseconds for normalized results written by the session. */
  readonly ttl?: number | undefined;
}

/** Core query-session execution config. Framework-level options live in adapter config types. */
export interface QuerySessionConfig extends QueryDefaults {
  /** Planner metadata generated from the GraphQL schema. Usually injected by generated accessors. */
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
  readonly optimistic?: ((cache: NormalizedCache) => void) | undefined;
  readonly invalidates?: readonly CacheInvalidation[] | undefined;
}

export type MutationSource<TInput extends Record<string, unknown>, TData> =
  | ((input: TInput) => Promise<TData>)
  | MutationOperation<TInput, TData>;

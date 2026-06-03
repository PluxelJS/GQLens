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

export type SlotValue = EntityRef | readonly EntityRef[] | readonly string[] | null | undefined;

export interface NormalizedCache {
  field<T = unknown>(ref: EntityRef, key: string): FieldSignal<T>;
  slot<T = SlotValue>(key: string): FieldSignal<T>;
  entity(type: string, id: string): EntityRef;
  normalize(data: GraphQLResult, ttl?: number): void;
  invalidate(ref: EntityRef, keys?: readonly string[]): void;
  invalidateSlot(key: string): void;
  isCached(ref: EntityRef, fieldKey: string): boolean;
  isSlotCached(key: string): boolean;
}

export interface SelectionPath {
  readonly root: string;
  readonly steps: readonly SelectionStep[];
}

export interface SelectionStep {
  readonly field: string;
  readonly args?: Record<string, unknown> | undefined;
}

export type CachePolicy = "cache-first" | "cache-and-network" | "network-only";

export interface QuerySessionConfig {
  readonly policy?: CachePolicy | undefined;
  readonly ttl?: number | undefined;
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
  readonly returnsEntity?: boolean | undefined;
  readonly returnsList?: boolean | undefined;
  readonly args?: Readonly<Record<string, string>> | undefined;
}

export interface PlannedSelectionPath {
  readonly root: string;
  readonly steps: readonly PlannedSelectionStep[];
}

export interface PlannedSelectionStep extends SelectionStep {
  readonly responseKey?: string | undefined;
}

export type InvalidationSpec = {
  readonly type: string;
  readonly id: string;
  readonly keys?: readonly string[] | undefined;
};

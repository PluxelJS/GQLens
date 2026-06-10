import type { ReaderHandle } from "../collector";
import type { GraphDataInvalidation, GraphDataStore, SelectionPath } from "../types";

export interface QuerySession {
  readonly store: GraphDataStore;
  mount(): ReaderHandle;
  unmount(reader: ReaderHandle): void;
  begin(reader: ReaderHandle): void;
  select(reader: ReaderHandle, path: SelectionPath): void;
  commit(reader: ReaderHandle): void;
  discard(reader: ReaderHandle): void;
  replace(reader: ReaderHandle, paths: readonly SelectionPath[]): void;
  readonly loading: () => boolean;
  readonly error: () => Error | null;
  schedule(): void;
  refetch(): void;
  invalidate(specs: readonly GraphDataInvalidation[]): void;
}

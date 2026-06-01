import { selectionKey } from "./keys";
import type { SelectionPath } from "./types";

export interface ReaderHandle {
  readonly id: number;
}

export interface SelectionCollector {
  register(): ReaderHandle;
  unregister(reader: ReaderHandle): void;
  begin(reader: ReaderHandle): void;
  select(reader: ReaderHandle, path: SelectionPath): void;
  commit(reader: ReaderHandle): void;
  discard(reader: ReaderHandle): void;
  replace(reader: ReaderHandle, paths: readonly SelectionPath[]): void;
  snapshot(): SelectionPath[];
  diff(prev: readonly SelectionPath[]): { added: SelectionPath[]; removed: SelectionPath[] };
}

interface ReaderState {
  active: SelectionPath[];
  draft: SelectionPath[] | null;
}

export function createSelectionCollector(): SelectionCollector {
  let nextId = 0;
  const readers = new Map<number, ReaderState>();

  return {
    register(): ReaderHandle {
      const handle = { id: nextId++ };
      readers.set(handle.id, { active: [], draft: null });
      return handle;
    },

    unregister(reader: ReaderHandle): void {
      readers.delete(reader.id);
    },

    begin(reader: ReaderHandle): void {
      const state = readers.get(reader.id);
      if (state) {
        state.draft = [];
      }
    },

    select(reader: ReaderHandle, path: SelectionPath): void {
      const state = readers.get(reader.id);
      if (!state) {
        return;
      }
      const target = state.draft ?? state.active;
      addUnique(target, path);
    },

    commit(reader: ReaderHandle): void {
      const state = readers.get(reader.id);
      if (!state || !state.draft) {
        return;
      }
      state.active = state.draft;
      state.draft = null;
    },

    discard(reader: ReaderHandle): void {
      const state = readers.get(reader.id);
      if (state) {
        state.draft = null;
      }
    },

    replace(reader: ReaderHandle, paths: readonly SelectionPath[]): void {
      const state = readers.get(reader.id);
      if (!state) {
        return;
      }
      state.active = unique(paths);
      state.draft = null;
    },

    snapshot(): SelectionPath[] {
      const paths: SelectionPath[] = [];
      for (const state of readers.values()) {
        paths.push(...state.active);
      }
      return unique(paths);
    },

    diff(prev: readonly SelectionPath[]): { added: SelectionPath[]; removed: SelectionPath[] } {
      const curr = this.snapshot();
      const prevSet = new Set(prev.map(selectionKey));
      const currSet = new Set(curr.map(selectionKey));
      return {
        added: curr.filter((path) => !prevSet.has(selectionKey(path))),
        removed: prev.filter((path) => !currSet.has(selectionKey(path))),
      };
    },
  };
}

function addUnique(target: SelectionPath[], path: SelectionPath): void {
  const key = selectionKey(path);
  if (!target.some((item) => selectionKey(item) === key)) {
    target.push(path);
  }
}

function unique(paths: readonly SelectionPath[]): SelectionPath[] {
  const seen = new Set<string>();
  const result: SelectionPath[] = [];
  for (const path of paths) {
    const key = selectionKey(path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(path);
  }
  return result;
}

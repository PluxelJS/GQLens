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
  reset(): void;
}

interface ReaderState {
  active: SelectionPath[];
  activeKeys: Set<string>;
  draft: SelectionPath[] | null;
  draftKeys: Set<string> | null;
}

export function createSelectionCollector(): SelectionCollector {
  let nextId = 0;
  const readers = new Map<number, ReaderState>();

  return {
    register(): ReaderHandle {
      const handle = { id: nextId++ };
      readers.set(handle.id, {
        active: [],
        activeKeys: new Set<string>(),
        draft: null,
        draftKeys: null,
      });
      return handle;
    },

    unregister(reader: ReaderHandle): void {
      readers.delete(reader.id);
    },

    begin(reader: ReaderHandle): void {
      const state = readers.get(reader.id);
      if (state) {
        state.draft = [];
        state.draftKeys = new Set<string>();
      }
    },

    select(reader: ReaderHandle, path: SelectionPath): void {
      const state = readers.get(reader.id);
      if (!state) {
        return;
      }
      const target = state.draft ?? state.active;
      const keys = state.draftKeys ?? state.activeKeys;
      addUnique(target, keys, path);
    },

    commit(reader: ReaderHandle): void {
      const state = readers.get(reader.id);
      if (!state || !state.draft) {
        return;
      }
      state.active = state.draft;
      state.activeKeys = state.draftKeys ?? new Set<string>();
      state.draft = null;
      state.draftKeys = null;
    },

    discard(reader: ReaderHandle): void {
      const state = readers.get(reader.id);
      if (state) {
        state.draft = null;
        state.draftKeys = null;
      }
    },

    replace(reader: ReaderHandle, paths: readonly SelectionPath[]): void {
      const state = readers.get(reader.id);
      if (!state) {
        return;
      }
      const next = unique(paths);
      state.active = next.paths;
      state.activeKeys = next.keys;
      state.draft = null;
      state.draftKeys = null;
    },

    snapshot(): SelectionPath[] {
      const paths: SelectionPath[] = [];
      for (const state of readers.values()) {
        paths.push(...state.active);
      }
      return unique(paths).paths;
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

    reset(): void {
      readers.clear();
    },
  };
}

function addUnique(target: SelectionPath[], keys: Set<string>, path: SelectionPath): void {
  const key = selectionKey(path);
  if (keys.has(key)) {
    return;
  }
  keys.add(key);
  target.push(path);
}

function unique(paths: readonly SelectionPath[]): {
  readonly paths: SelectionPath[];
  readonly keys: Set<string>;
} {
  const keys = new Set<string>();
  const result: SelectionPath[] = [];
  for (const path of paths) {
    const key = selectionKey(path);
    if (keys.has(key)) {
      continue;
    }
    keys.add(key);
    result.push(path);
  }
  return { paths: result, keys };
}

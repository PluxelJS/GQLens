import { useLayoutEffect, useMemo, useReducer, useRef } from "react";
import {
  selectionKey,
  watchSignal,
  type AlienSignalReader,
  type QuerySession,
  type SelectionPath,
  type SelectionStep,
} from "@gqlens/core";

export interface ReaderScope {
  demand(root: string, steps: readonly SelectionStep[]): void;
  read<T>(sig: AlienSignalReader<T>): T;
}

export function useRenderTracking(session: QuerySession): ReaderScope {
  const signalsRef = useRef<Set<AlienSignalReader>>(new Set());
  const pathsRef = useRef<SelectionPath[]>([]);
  const readerRef = useRef<ReturnType<QuerySession["mount"]> | null>(null);
  const pathKeyRef = useRef("");
  const [, forceRender] = useReducer((value: number) => value + 1, 0);

  signalsRef.current = new Set<AlienSignalReader>();
  pathsRef.current = [];

  useLayoutEffect(() => {
    const reader = session.mount();
    readerRef.current = reader;
    return () => {
      readerRef.current = null;
      pathKeyRef.current = "";
      session.unmount(reader);
    };
  }, [session]);

  useLayoutEffect(() => {
    const reader = readerRef.current;
    if (!reader) {
      return;
    }

    const paths = pathsRef.current;
    const nextPathKey = pathSetKey(paths);
    if (nextPathKey !== pathKeyRef.current) {
      pathKeyRef.current = nextPathKey;
      session.replace(reader, paths);
      session.schedule();
    }
  });

  useLayoutEffect(() => {
    const unsubscribers = [...signalsRef.current].map((sig) => watchSignal(sig, forceRender));
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  });

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
    [],
  );
}

function pathSetKey(paths: readonly SelectionPath[]): string {
  return paths.map(selectionKey).toSorted().join("\n");
}

function addSelection(paths: SelectionPath[], path: SelectionPath): void {
  const key = selectionKey(path);
  if (!paths.some((item) => selectionKey(item) === key)) {
    paths.push(path);
  }
}

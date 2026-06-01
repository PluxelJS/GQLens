import { effect, signal } from "alien-signals";
import type { AlienSignal, AlienSignalReader } from "./types";

export function createSignal<T>(initial: T): AlienSignal<T> {
  return signal(initial);
}

export function watchSignal(sig: AlienSignalReader, listener: () => void): () => void {
  let initialized = false;
  return effect(() => {
    sig();
    if (initialized) {
      listener();
    }
    initialized = true;
  });
}

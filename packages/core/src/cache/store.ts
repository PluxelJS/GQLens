import { createSignal } from "../signal";
import type { FieldSignal } from "../types";
import { suffixedSlotKey, type CacheSlotSuffix } from "./address";

export type FieldEntry<T = unknown> = FieldSignal<T>;

export interface CacheStore {
  readonly fields: Map<string, FieldEntry>;
  readonly slots: Map<string, FieldEntry>;
}

export function createCacheStore(): CacheStore {
  return {
    fields: new Map<string, FieldEntry>(),
    slots: new Map<string, FieldEntry>(),
  };
}

export function getEntry<T>(store: Map<string, FieldEntry>, key: string): FieldSignal<T> {
  const existing = store.get(key);
  if (existing) {
    return existing as FieldSignal<T>;
  }

  const entry: FieldEntry<T> = {
    sig: createSignal<T>(undefined as T),
    expires: 0,
  };
  store.set(key, entry as FieldEntry);
  return entry;
}

export function writeEntry<T>(
  store: Map<string, FieldEntry>,
  key: string,
  value: T,
  expires: number,
): void {
  const entry = getEntry<T>(store, key);
  entry.sig(value);
  entry.expires = expires;
}

export function clearSlotIdentities(slots: Map<string, FieldEntry>, slotKey: string): void {
  clearSlotSuffix(slots, slotKey, "ids");
  clearSlotSuffix(slots, slotKey, "refs");
}

export function clearSlotSuffix(
  slots: Map<string, FieldEntry>,
  slotKey: string,
  suffix: CacheSlotSuffix,
): void {
  const entry = slots.get(suffixedSlotKey(slotKey, suffix));
  if (entry) {
    entry.sig(undefined);
    entry.expires = 0;
  }
}

export function expiresAt(ttl: number): number {
  return ttl > 0 ? Date.now() + ttl : 0;
}

export function isExpiresFresh(expires: number): boolean {
  return expires === 0 || expires > Date.now();
}

export function isFresh(entry: FieldEntry | undefined): boolean {
  if (!entry) {
    return false;
  }
  if (entry.sig() === undefined) {
    return false;
  }
  return isExpiresFresh(entry.expires);
}

export function markStale(entry: FieldEntry | undefined): void {
  if (entry) {
    entry.expires = Date.now() - 1;
  }
}

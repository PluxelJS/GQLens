import type { GraphDataAddress, EntityRef, FieldSignal, GraphDataStore } from "@gqlens/core";

type TestSlotValue = EntityRef | readonly EntityRef[] | readonly string[] | null | undefined;

export function cacheField<T = unknown>(
  cache: GraphDataStore,
  ref: EntityRef,
  key: string,
): FieldSignal<T> {
  return cache.entry<T>({ owner: { kind: "entity", ref }, path: [{ field: key }] });
}

export function cacheSlot<T = TestSlotValue>(cache: GraphDataStore, key: string): FieldSignal<T> {
  return cache.entry<T>(slotAddress(key));
}

export function peekCacheField<T = unknown>(
  cache: GraphDataStore,
  ref: EntityRef,
  key: string,
): FieldSignal<T> | undefined {
  return cache.peek<T>({ owner: { kind: "entity", ref }, path: [{ field: key }] });
}

export function peekCacheSlot<T = TestSlotValue>(
  cache: GraphDataStore,
  key: string,
): FieldSignal<T> | undefined {
  return cache.peek<T>(slotAddress(key));
}

export function isCacheFieldFresh(cache: GraphDataStore, ref: EntityRef, key: string): boolean {
  return cache.isFresh({ owner: { kind: "entity", ref }, path: [{ field: key }] });
}

export function isCacheSlotFresh(cache: GraphDataStore, key: string): boolean {
  return cache.isFresh(slotAddress(key));
}

function slotAddress(key: string): GraphDataAddress {
  const { base, facet } = splitFacet(key);
  const entity = /^([^:.]+):([^.]+)\.(.+)$/.exec(base);
  if (entity) {
    return {
      owner: { kind: "entity", ref: { type: entity[1]!, id: entity[2]! } },
      path: [{ field: entity[3]! }],
      facet: facet ?? "link",
    };
  }

  const dot = base.indexOf(".");
  if (dot < 0) {
    return { owner: { kind: "root", root: base }, path: [], facet };
  }
  return {
    owner: { kind: "root", root: base.slice(0, dot) },
    path: [{ field: base.slice(dot + 1) }],
    facet,
  };
}

function splitFacet(key: string): {
  readonly base: string;
  readonly facet?: "ids" | "refs" | undefined;
} {
  if (key.endsWith(".ids")) {
    return { base: key.slice(0, -4), facet: "ids" };
  }
  if (key.endsWith(".refs")) {
    return { base: key.slice(0, -5), facet: "refs" };
  }
  return { base: key };
}

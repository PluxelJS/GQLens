import type { EntityRef } from "../types";

export interface EntityRefStore {
  entity(type: string, id: string): EntityRef;
}

export function createEntityRefStore(): EntityRefStore {
  const refs = new Map<string, EntityRef>();

  return {
    entity(type: string, id: string): EntityRef {
      const key = `${type}:${id}`;
      let ref = refs.get(key);
      if (!ref) {
        ref = { type, id };
        refs.set(key, ref);
      }
      return ref;
    },
  };
}

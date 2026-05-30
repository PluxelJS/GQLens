import type { Lens } from "@gqlens/core";

export function createLensResource(_lens: Lens): () => Record<string, unknown> {
  return () => ({});
}

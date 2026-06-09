import { describe, expect, test } from "vitest";
import type { EntityMeta, NormalizerEntry } from "@gqlens/core/codegen";

describe("core/codegen metadata contracts", () => {
  test("entity and normalizer metadata stay JSON-serializable", () => {
    const entity: EntityMeta = {
      type: "User",
      identityKeys: ["id", "__typename"],
      fields: {
        id: { name: "id", kind: "scalar" },
        name: { name: "name", kind: "scalar" },
        posts: { name: "posts", kind: "list", typeName: "Post" },
      },
    };
    const normalizer: NormalizerEntry = {
      type: "User",
      fields: [
        { responseKey: "id", cacheKey: "id" },
        { responseKey: "name", cacheKey: "name" },
        { responseKey: "posts", cacheKey: "posts", nestedType: "Post", isList: true },
      ],
    };

    const roundTrip = JSON.parse(JSON.stringify({ entity, normalizer })) as {
      readonly entity: EntityMeta;
      readonly normalizer: NormalizerEntry;
    };

    expect(roundTrip).toStrictEqual({ entity, normalizer });
  });
});

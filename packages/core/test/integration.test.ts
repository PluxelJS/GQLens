import { describe, expect, test } from "vitest";
import { createNormalizedCache, plan } from "@gqlens/core";
import { cacheField } from "./cache-helpers";

// ─── Planner + Cache integration ───────────────────────────────────────────

describe("End-to-end: Plan → Fetch → Normalize → Read", () => {
  test("round-trip: entity with nested relation and list", () => {
    const cache = createNormalizedCache();
    void plan([
      { root: "Query", steps: [{ field: "user", args: { id: "1" } }, { field: "name" }] },
      {
        root: "Query",
        steps: [
          { field: "user", args: { id: "1" } },
          { field: "posts", args: { first: 5 } },
          { field: "title" },
        ],
      },
    ]);

    cache.normalize({
      user: {
        __typename: "User",
        id: "1",
        name: "Alice",
        posts: [
          { __typename: "Post", id: "10", title: "First post" },
          { __typename: "Post", id: "11", title: "Second post" },
        ],
      },
    });

    const userRef = cache.entity("User", "1");
    expect(cacheField<string>(cache, userRef, "name").sig()).toBe("Alice");

    const post1Ref = cache.entity("Post", "10");
    expect(cacheField<string>(cache, post1Ref, "title").sig()).toBe("First post");

    const post2Ref = cache.entity("Post", "11");
    expect(cacheField<string>(cache, post2Ref, "title").sig()).toBe("Second post");
  });
});

import { describe, expect, test } from "vitest";
import { createNormalizedCache, type SelectionStep } from "@gqlens/core";
import {
  createAccessorNode,
  type AccessorContext,
  type EntityMeta,
  type NormalizerEntry,
  type SchemaMeta,
} from "@gqlens/core/codegen";

interface QueryNode {
  readonly viewer: UserNode;
  user(args: { id: string }): UserNode;
}

interface UserNode {
  readonly name: string | undefined;
  readonly posts: { readonly ids: readonly string[] | undefined };
}

const schemaMeta: SchemaMeta = {
  query: {
    type: "Query",
    identityKeys: ["id", "__typename"],
    fields: {
      viewer: { name: "viewer", kind: "entity", typeName: "User" },
      user: { name: "user", kind: "entity", typeName: "User", hasArgs: true },
    },
  },
  entities: {
    User: {
      type: "User",
      identityKeys: ["id", "__typename"],
      fields: {
        name: { name: "name", kind: "scalar" },
        posts: { name: "posts", kind: "list", typeName: "Post" },
      },
    },
  },
};

describe("core/codegen types", () => {
  describe("EntityMeta", () => {
    test("can create EntityMeta instances", () => {
      const meta: EntityMeta = {
        type: "User",
        identityKeys: ["id", "__typename"],
        fields: {
          name: { name: "name", kind: "scalar" },
          avatar: { name: "avatar", kind: "scalar" },
        },
      };
      expect(meta.type).toBe("User");
      expect(meta.identityKeys).toContain("id");
      expect(meta.fields["name"]?.kind).toBe("scalar");
    });
  });

  describe("NormalizerEntry", () => {
    test("supports nested and list fields", () => {
      const entry: NormalizerEntry = {
        type: "Post",
        fields: [
          { responseKey: "title", cacheKey: "title" },
          { responseKey: "author", cacheKey: "author", nestedType: "User" },
          { responseKey: "comments", cacheKey: "comments", nestedType: "Comment", isList: true },
        ],
      };
      expect(entry.fields[1]!.nestedType).toBe("User");
      expect(entry.fields[2]!.isList).toBe(true);
    });
  });

  describe("serializable metadata", () => {
    test("can round-trip normalizer entries through JSON", () => {
      const entries: NormalizerEntry[] = [
        { type: "User", fields: [{ responseKey: "name", cacheKey: "name" }] },
      ];
      const read = JSON.parse(JSON.stringify(entries)) as NormalizerEntry[];
      expect(read).toStrictEqual(entries);
    });
  });
});

describe("createAccessorNode", () => {
  test("declares demand and reads entity fields through root slots", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cache.normalize({ viewer: { __typename: "User", id: "1", name: "Alice" } });
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(query.viewer.name).toBe("Alice");
    expect(demands).toStrictEqual([[{ field: "viewer" }, { field: "name" }]]);
  });

  test("uses root id args as an entity resolver before a slot exists", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cache.field(cache.entity("User", "2"), "name").sig("Bob");
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(query.user({ id: "2" }).name).toBe("Bob");
    expect(demands).toStrictEqual([[{ field: "user", args: { id: "2" } }, { field: "name" }]]);
  });

  test("prefers cached null root slots over root id entity shortcuts", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cache.field(cache.entity("User", "2"), "name").sig("stale Bob");
    cache.slot('Query.user({"id":"2"})').sig(null);
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(query.user({ id: "2" }).name).toBeUndefined();
    expect(demands).toStrictEqual([[{ field: "user", args: { id: "2" } }, { field: "name" }]]);
  });

  test("reads relation list ids from the owning entity field", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cache.normalize({
      viewer: {
        __typename: "User",
        id: "1",
        name: "Alice",
        posts: [
          { __typename: "Post", id: "10" },
          { __typename: "Post", id: "11" },
        ],
      },
    });
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(query.viewer.posts.ids).toStrictEqual(["10", "11"]);
    expect(demands).toStrictEqual([[{ field: "viewer" }, { field: "posts" }, { field: "ids" }]]);
  });

  test("reuses relation and list accessor objects without caching scalar reads", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cache.normalize({ viewer: { __typename: "User", id: "1", name: "Alice" } });
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(Object.is(query.viewer, query.viewer)).toBe(true);
    expect(Object.is(query.user({ id: "1" }), query.user({ id: "1" }))).toBe(true);
    expect(Object.is(query.user({ id: "1" }), query.user({ id: "2" }))).toBe(false);
    expect(Object.is(query.viewer.posts, query.viewer.posts)).toBe(true);

    (demands as SelectionStep[][]).splice(0);
    expect(query.viewer.name).toBe("Alice");
    cache.field(cache.entity("User", "1"), "name").sig("Bob");
    expect(query.viewer.name).toBe("Bob");
    expect(demands).toStrictEqual([
      [{ field: "viewer" }, { field: "name" }],
      [{ field: "viewer" }, { field: "name" }],
    ]);
  });

  test("keeps accessor fields non-enumerable to avoid accidental reads", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cache.normalize({
      viewer: {
        __typename: "User",
        id: "1",
        name: "Alice",
        posts: [{ __typename: "Post", id: "10" }],
      },
    });
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(Object.keys(query)).toStrictEqual([]);
    expect(Object.keys(query.viewer)).toStrictEqual([]);
    expect(Object.keys(query.viewer.posts)).toStrictEqual([]);
    expect(JSON.stringify(query.viewer)).toBe("{}");
    expect(demands).toStrictEqual([]);

    expect(query.viewer.name).toBe("Alice");
    expect(query.viewer.posts.ids).toStrictEqual(["10"]);
    expect(demands).toStrictEqual([
      [{ field: "viewer" }, { field: "name" }],
      [{ field: "viewer" }, { field: "posts" }, { field: "ids" }],
    ]);
  });

  test("returns undefined for missing list identity", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cache.normalize({ viewer: { __typename: "User", id: "1", name: "Alice" } });
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(query.viewer.posts.ids).toBeUndefined();
    expect(demands).toStrictEqual([[{ field: "viewer" }, { field: "posts" }, { field: "ids" }]]);
  });
});

function ctx(
  cache: ReturnType<typeof createNormalizedCache>,
  demands: readonly SelectionStep[][],
): AccessorContext {
  return {
    root: "Query",
    cache,
    demand(steps) {
      (demands as SelectionStep[][]).push([...steps]);
    },
    read(sig) {
      return sig();
    },
  };
}

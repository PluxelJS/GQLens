import { describe, expect, test } from "vitest";
import { createNormalizedCache, type SelectionStep } from "@gqlens/core";
import {
  bindSelection,
  createAccessorNode,
  defineInvalidation,
  defineSelection,
  type AccessorContext,
  type SchemaMeta,
} from "@gqlens/core/codegen";
import { cacheField, cacheSlot } from "./cache-helpers";

interface QueryNode {
  readonly __typename: string | undefined;
  readonly viewer: UserNode;
  user(args: { id: string }): UserNode;
  pet(args: { id: string }): PetNode;
  search(args: { text: string }): {
    readonly refs: readonly { type: string; id: string }[] | undefined;
  };
}

interface UserNode {
  readonly __typename: string | undefined;
  readonly name: string | undefined;
  readonly status: UserStatusNode;
  readonly posts: { readonly ids: readonly string[] | undefined };
}

interface UserStatusNode {
  readonly online: boolean | undefined;
  readonly source: StatusSourceNode;
}

interface StatusSourceNode {
  readonly kind: string | undefined;
}

interface PetNode {
  readonly __typename: string | undefined;
  readonly name: string | undefined;
  readonly $on: {
    readonly Cat: CatNode;
    readonly Dog: DogNode;
  };
}

interface CatNode {
  readonly __typename: string | undefined;
  readonly name: string | undefined;
  readonly meows: boolean | undefined;
}

interface DogNode {
  readonly __typename: string | undefined;
  readonly name: string | undefined;
  readonly barks: boolean | undefined;
}

const schemaMeta: SchemaMeta = {
  query: {
    type: "Query",
    identityKeys: ["id", "__typename"],
    fields: {
      __typename: { name: "__typename", kind: "scalar" },
      viewer: { name: "viewer", kind: "entity", typeName: "User" },
      user: { name: "user", kind: "entity", typeName: "User", hasArgs: true },
      pet: { name: "pet", kind: "entity", typeName: "Pet", hasArgs: true, isAbstract: true },
      search: {
        name: "search",
        kind: "list",
        typeName: "SearchResult",
        hasArgs: true,
        isAbstract: true,
      },
    },
  },
  entities: {
    User: {
      type: "User",
      identityKeys: ["id", "__typename"],
      fields: {
        __typename: { name: "__typename", kind: "scalar" },
        name: { name: "name", kind: "scalar" },
        status: {
          name: "status",
          kind: "value",
          typeName: "UserStatus",
          targetObjectKind: "value",
        },
        posts: { name: "posts", kind: "list", typeName: "Post" },
      },
    },
    UserStatus: {
      type: "UserStatus",
      kind: "value",
      identityKeys: [],
      fields: {
        online: { name: "online", kind: "scalar" },
        source: {
          name: "source",
          kind: "value",
          typeName: "StatusSource",
          targetObjectKind: "value",
        },
      },
    },
    StatusSource: {
      type: "StatusSource",
      kind: "value",
      identityKeys: [],
      fields: {
        kind: { name: "kind", kind: "scalar" },
      },
    },
    Pet: {
      type: "Pet",
      identityKeys: ["id", "__typename"],
      isAbstract: true,
      possibleTypes: ["Cat", "Dog"],
      fields: {
        __typename: { name: "__typename", kind: "scalar" },
        name: { name: "name", kind: "scalar" },
      },
    },
    Cat: {
      type: "Cat",
      identityKeys: ["id", "__typename"],
      fields: {
        __typename: { name: "__typename", kind: "scalar" },
        name: { name: "name", kind: "scalar" },
        meows: { name: "meows", kind: "scalar" },
      },
    },
    Dog: {
      type: "Dog",
      identityKeys: ["id", "__typename"],
      fields: {
        __typename: { name: "__typename", kind: "scalar" },
        name: { name: "name", kind: "scalar" },
        barks: { name: "barks", kind: "scalar" },
      },
    },
  },
};

describe("createAccessorNode", () => {
  test("declares demand and reads entity fields through root slots", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cache.normalize({ viewer: { __typename: "User", id: "1", name: "Alice" } });
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(query.viewer.name).toBe("Alice");
    expect(demands).toStrictEqual([[{ field: "viewer" }, { field: "name" }]]);
  });

  test("reads __typename through the same scalar accessor path", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cache.normalize({ user: { __typename: "User", id: "1", name: "Alice" } });
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(query.user({ id: "1" })["__typename"]).toBe("User");
    expect(demands).toStrictEqual([
      [{ field: "user", args: { id: "1" } }, { field: "__typename" }],
    ]);
  });

  test("uses root id args as an entity resolver before a slot exists", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cacheField(cache, cache.entity("User", "2"), "name").sig("Bob");
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(query.user({ id: "2" }).name).toBe("Bob");
    expect(demands).toStrictEqual([[{ field: "user", args: { id: "2" } }, { field: "name" }]]);
  });

  test("prefers cached null root slots over root id entity shortcuts", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cacheField(cache, cache.entity("User", "2"), "name").sig("stale Bob");
    cacheSlot(cache, 'Query.user({"id":"2"})').sig(null);
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

  test("reads embedded value object leaves from the owning entity field path", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cacheField(cache, cache.entity("User", "1"), "status.source.kind").sig("hmr");
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(query.user({ id: "1" }).status.source.kind).toBe("hmr");
    expect(demands).toStrictEqual([
      [
        { field: "user", args: { id: "1" } },
        { field: "status" },
        { field: "source" },
        { field: "kind" },
      ],
    ]);
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
    cacheField(cache, cache.entity("User", "1"), "name").sig("Bob");
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

  test("returns undefined for missing relation list ids", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cache.normalize({ viewer: { __typename: "User", id: "1", name: "Alice" } });
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(query.viewer.posts.ids).toBeUndefined();
    expect(demands).toStrictEqual([[{ field: "viewer" }, { field: "posts" }, { field: "ids" }]]);
  });

  test("reads abstract list refs and declares refs demand", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cache.normalize({
      search: [
        { __typename: "User", id: "1", name: "Alice" },
        { __typename: "Cat", id: "2", name: "Miso", meows: true },
      ],
    });
    cacheSlot(cache, 'Query.search({"text":"mi"}).refs').sig([
      { type: "User", id: "1" },
      { type: "Cat", id: "2" },
    ]);
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(query.search({ text: "mi" }).refs).toStrictEqual([
      { type: "User", id: "1" },
      { type: "Cat", id: "2" },
    ]);
    expect(demands).toStrictEqual([[{ field: "search", args: { text: "mi" } }, { field: "refs" }]]);
  });

  test("reads inline fragment fields only when the cached type matches", () => {
    const cache = createNormalizedCache();
    const demands: readonly SelectionStep[][] = [];
    cache.normalize({
      pet: { __typename: "Cat", id: "1", name: "Miso", meows: true },
      dog: { __typename: "Dog", id: "2", name: "Rex", barks: true },
    });
    cacheSlot(cache, 'Query.pet({"id":"1"})').sig({ type: "Cat", id: "1" });
    cacheSlot(cache, 'Query.pet({"id":"2"})').sig({ type: "Dog", id: "2" });
    const query = createAccessorNode<QueryNode>(ctx(cache, demands), schemaMeta, schemaMeta.query);

    expect(query.pet({ id: "1" }).$on.Cat.meows).toBe(true);
    expect(query.pet({ id: "2" }).$on.Cat.meows).toBeUndefined();
    expect(demands).toStrictEqual([
      [
        { field: "pet", args: { id: "1" } },
        { field: "$on", typeCondition: "Cat" },
        { field: "meows" },
      ],
      [
        { field: "pet", args: { id: "2" } },
        { field: "$on", typeCondition: "Cat" },
        { field: "meows" },
      ],
    ]);
  });

  test("defineSelection collects paths and named variable placeholders", () => {
    const selection = defineSelection<QueryNode>(
      schemaMeta,
      schemaMeta.query,
      (query, variable) => {
        void query.user({ id: variable("id") as unknown as string }).name;
        void query.search({ text: variable("text") as unknown as string }).refs;
      },
    );

    expect(selection.variables).toStrictEqual(["id", "text"]);
    expect(selection.paths).toStrictEqual([
      {
        root: "Query",
        steps: [{ field: "user", args: { id: { __gqlensVariable: "id" } } }, { field: "name" }],
      },
      {
        root: "Query",
        steps: [
          { field: "search", args: { text: { __gqlensVariable: "text" } } },
          { field: "refs" },
        ],
      },
    ]);
  });

  test("bindSelection binds prepared variables into plain selection paths", () => {
    const selection = defineSelection<QueryNode>(
      schemaMeta,
      schemaMeta.query,
      (query, variable) => {
        void query.user({ id: variable("id") as unknown as string }).name;
      },
    );

    expect(bindSelection(selection, { id: "1" })).toStrictEqual([
      {
        root: "Query",
        steps: [{ field: "user", args: { id: "1" } }, { field: "name" }],
      },
    ]);
  });

  test("bindSelection fails fast when a prepared variable is missing", () => {
    const selection = defineSelection<QueryNode>(
      schemaMeta,
      schemaMeta.query,
      (query, variable) => {
        void query.user({ id: variable("id") as unknown as string }).name;
      },
    );

    expect(() => bindSelection(selection, {})).toThrow(
      "Missing GQLens prepared selection variable: id",
    );
  });

  test("bindSelection only accepts own variable bindings", () => {
    const selection = defineSelection<QueryNode>(
      schemaMeta,
      schemaMeta.query,
      (query, variable) => {
        void query.user({ id: variable("id") as unknown as string }).name;
      },
    );
    const variables = Object.create({ id: "1" }) as Record<string, unknown>;

    expect(() => bindSelection(selection, variables)).toThrow(
      "Missing GQLens prepared selection variable: id",
    );
  });

  test("bindSelection preserves non-plain literal values while binding nested variables", () => {
    const since = new Date("2026-01-01T00:00:00.000Z");
    const selection = {
      variables: ["id"],
      paths: [
        {
          root: "Query",
          steps: [
            {
              field: "search",
              args: {
                filter: {
                  owner: { __gqlensVariable: "id" },
                  since,
                },
              },
            },
            { field: "ids" },
          ],
        },
      ],
    };

    const [path] = bindSelection(selection, { id: "1" });
    expect(path).toBeDefined();
    expect(path?.steps[0]?.args).toStrictEqual({
      filter: {
        owner: "1",
        since,
      },
    });
    const filter = path!.steps[0]!.args!["filter"] as { readonly since: Date };
    expect(filter.since).toBe(since);
  });

  test("defineInvalidation can capture relation accessors without reading a field", () => {
    const path = defineInvalidation<QueryNode>(
      schemaMeta,
      schemaMeta.query,
      (query) => query.user({ id: "1" }).posts,
    );

    expect(path).toStrictEqual({
      kind: "root",
      root: "Query",
      paths: [[{ field: "user", args: { id: "1" } }, { field: "posts" }]],
    });
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

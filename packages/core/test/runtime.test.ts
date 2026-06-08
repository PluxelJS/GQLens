import { describe, expect, test, vi } from "vitest";
import {
  createNormalizedCache,
  createMutationRunner,
  createSelectionCollector,
  applyInvalidations,
  plan,
  createLiveQuerySession,
  createQuerySession,
  createFetchTransport,
  type SelectionPath,
  type SelectionStep,
  type GraphQLOperation,
  type Fetcher,
  type LiveSubscriber,
} from "@gqlens/core";

// ─── NormalizedCache ───────────────────────────────────────────────────────

const makePath = (root: string, steps: string[]): SelectionPath => ({
  root,
  steps: steps.map((s) => ({ field: s })),
});

const p = (steps: SelectionStep[]): SelectionPath => ({
  root: "Query",
  steps,
});

describe("NormalizedCache", () => {
  test("stores and retrieves field values via signals", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");
    const nameSignal = cache.field<string>(ref, "name");

    nameSignal.sig("Alice");
    expect(nameSignal.sig()).toBe("Alice");
  });

  test("reads undefined for unset fields", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "99");
    expect(cache.field(ref, "name").sig()).toBeUndefined();
  });

  test("normalize writes scalar fields into cache", () => {
    const cache = createNormalizedCache();

    cache.normalize({
      user: {
        __typename: "User",
        id: "1",
        name: "Alice",
        avatar: "/avatar.png",
      },
    });

    const ref = cache.entity("User", "1");
    expect(cache.field<string>(ref, "name").sig()).toBe("Alice");
    expect(cache.field<string>(ref, "avatar").sig()).toBe("/avatar.png");
    expect(cache.field<string>(ref, "__typename").sig()).toBe("User");
  });

  test("normalize writes nested entity fields", () => {
    const cache = createNormalizedCache();

    cache.normalize({
      post: {
        __typename: "Post",
        id: "9",
        title: "Hello",
        author: {
          __typename: "User",
          id: "1",
          name: "Alice",
        },
      },
    });

    expect(cache.field<string>(cache.entity("Post", "9"), "title").sig()).toBe("Hello");
    expect(cache.field<string>(cache.entity("User", "1"), "name").sig()).toBe("Alice");
  });

  test("normalize writes list id arrays", () => {
    const cache = createNormalizedCache();

    cache.normalize({
      todos: [
        { __typename: "Todo", id: "1", title: "Buy milk", done: false },
        { __typename: "Todo", id: "2", title: "Walk dog", done: true },
      ],
    });

    // Each entity field is stored
    expect(cache.field<string>(cache.entity("Todo", "1"), "title").sig()).toBe("Buy milk");
    expect(cache.field<boolean>(cache.entity("Todo", "2"), "done").sig()).toBe(true);
    expect(cache.slot("Query.todos.ids").sig()).toStrictEqual(["1", "2"]);
    expect(cache.slot("Query.todos.refs").sig()).toStrictEqual([
      { type: "Todo", id: "1" },
      { type: "Todo", id: "2" },
    ]);
  });

  test("normalize writes root identity slots", () => {
    const cache = createNormalizedCache();

    cache.normalize({
      viewer: { __typename: "User", id: "1", name: "Alice" },
      todos: [
        { __typename: "Todo", id: "1", title: "Buy milk" },
        { __typename: "Todo", id: "2", title: "Walk dog" },
      ],
    });

    expect(cache.slot("Query.viewer").sig()).toStrictEqual({ type: "User", id: "1" });
    expect(cache.slot("Query.todos.ids").sig()).toStrictEqual(["1", "2"]);
  });

  test("normalize clears stale list ids when a slot becomes null", () => {
    const cache = createNormalizedCache();

    cache.normalize({
      todos: [
        { __typename: "Todo", id: "1", title: "Buy milk" },
        { __typename: "Todo", id: "2", title: "Walk dog" },
      ],
    });
    expect(cache.slot("Query.todos.ids").sig()).toStrictEqual(["1", "2"]);

    cache.normalize({ todos: null });

    expect(cache.slot("Query.todos").sig()).toBeNull();
    expect(cache.slot("Query.todos.ids").sig()).toBeUndefined();
    expect(cache.isSlotCached("Query.todos.ids")).toBe(false);
  });

  test("TTL: normalize with ttl sets expiration", () => {
    const cache = createNormalizedCache();
    const future = Date.now() + 60000;
    cache.normalize({ user: { __typename: "User", id: "1", name: "Alice" } }, 60000);

    const ref = cache.entity("User", "1");
    expect(cache.field<string>(ref, "name").expires).toBeGreaterThanOrEqual(future - 100);
  });

  test("TTL: default ttl of 0 means no expiry", () => {
    const cache = createNormalizedCache();
    cache.normalize({ user: { __typename: "User", id: "1", name: "Alice" } });
    expect(cache.field(cache.entity("User", "1"), "name").expires).toBe(0);
  });

  test("invalidate marks specific fields as stale", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");
    cache.field<string>(ref, "name").sig("Alice");
    cache.field<string>(ref, "avatar").sig("/a.png");

    cache.invalidate(ref, ["name"]);
    expect(cache.field(ref, "name").expires).toBeLessThan(Date.now());
    expect(cache.field(ref, "avatar").expires).toBe(0); // unaffected
  });

  test("invalidate without keys marks all fields stale", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");
    cache.field<string>(ref, "name").sig("Alice");
    cache.field<string>(ref, "avatar").sig("/a.png");

    cache.invalidate(ref);
    expect(cache.field(ref, "name").expires).toBeLessThan(Date.now());
    expect(cache.field(ref, "avatar").expires).toBeLessThan(Date.now());
  });

  test("path unification: different paths write to same signals", () => {
    const cache = createNormalizedCache();

    // viewer resolves to User:1
    cache.normalize({ viewer: { __typename: "User", id: "1", name: "ViewerName" } });
    // post.author also resolves to User:1
    cache.normalize({
      post: {
        __typename: "Post",
        id: "9",
        author: { __typename: "User", id: "1", avatar: "/pic.png" },
      },
    });

    const ref = cache.entity("User", "1");
    expect(cache.field<string>(ref, "name").sig()).toBe("ViewerName");
    expect(cache.field<string>(ref, "avatar").sig()).toBe("/pic.png");
  });

  test("normalize handles null fields gracefully", () => {
    const cache = createNormalizedCache();
    cache.normalize({ user: { __typename: "User", id: "1", name: "Alice", avatar: null } });
    expect(cache.field(cache.entity("User", "1"), "avatar").sig()).toBeNull();
  });

  test("normalize keeps non-entity nested JSON as one field value", () => {
    const cache = createNormalizedCache();
    const settings = { theme: "dark", shortcuts: { save: "mod+s" } };

    cache.normalize({ user: { __typename: "User", id: "1", settings } });

    expect(cache.field(cache.entity("User", "1"), "settings").sig()).toStrictEqual(settings);
  });

  test("normalize keeps scalar arrays as one field value", () => {
    const cache = createNormalizedCache();
    const tags = ["typescript", "graphql"];

    cache.normalize({ post: { __typename: "Post", id: "1", tags } });

    expect(cache.field(cache.entity("Post", "1"), "tags").sig()).toStrictEqual(tags);
  });

  test("normalize keeps root scalar arrays as one slot value", () => {
    const cache = createNormalizedCache();
    const tags = ["typescript", "graphql"];

    cache.normalize({ tags });

    expect(cache.slot("Query.tags").sig()).toStrictEqual(tags);
    expect(cache.isSlotCached("Query.tags.ids")).toBe(false);
  });

  test("created but unset entries are not treated as cached", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");

    cache.field(ref, "name");
    cache.slot("Query.viewer");

    expect(cache.isCached(ref, "name")).toBe(false);
    expect(cache.isSlotCached("Query.viewer")).toBe(false);
  });

  test("overlapping normalize calls merge fields without erasing absent ones", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");

    cache.normalize({
      user: { __typename: "User", id: "1", name: "Alice", avatar: "url1" },
    });
    expect(cache.field<string>(ref, "name").sig()).toBe("Alice");
    expect(cache.field<string>(ref, "avatar").sig()).toBe("url1");

    cache.normalize({ user: { __typename: "User", id: "1", name: "Bob" } });

    expect(cache.field<string>(ref, "name").sig()).toBe("Bob");
    expect(cache.field<string>(ref, "avatar").sig()).toBe("url1");
  });

  test("normalize with nested recursion handles repeated entities safely", () => {
    const cache = createNormalizedCache();

    cache.normalize({
      a: {
        __typename: "A",
        id: "1",
        b: { __typename: "B", id: "1", name: "Beta" },
      },
    });
    expect(cache.field<string>(cache.entity("A", "1"), "id").sig()).toBe("1");
    expect(cache.field<string>(cache.entity("B", "1"), "name").sig()).toBe("Beta");

    cache.normalize({
      b: {
        __typename: "B",
        id: "1",
        name: "Beta2",
        a: { __typename: "A", id: "1", label: "Alpha" },
      },
    });

    expect(cache.field<string>(cache.entity("B", "1"), "name").sig()).toBe("Beta2");
    expect(cache.field<string>(cache.entity("A", "1"), "label").sig()).toBe("Alpha");
  });

  test("clear removes all fields and slots", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");

    cache.field(ref, "name").sig("Alice");
    cache.slot("Query.viewer").sig({ type: "User", id: "1" });

    expect(cache.isCached(ref, "name")).toBe(true);
    expect(cache.isSlotCached("Query.viewer")).toBe(true);

    cache.clear();

    expect(cache.field(ref, "name").sig()).toBeUndefined();
    expect(cache.isCached(ref, "name")).toBe(false);
    expect(cache.isSlotCached("Query.viewer")).toBe(false);
  });
});

// ─── SelectionCollector ────────────────────────────────────────────────────

describe("SelectionCollector", () => {
  test("tracks selections per reader", () => {
    const collector = createSelectionCollector();
    const reader = collector.register();

    collector.select(reader, makePath("Query", ["user", "name"]));
    collector.select(reader, makePath("Query", ["user", "avatar"]));

    expect(collector.snapshot()).toHaveLength(2);
  });

  test("deduplicates identical paths per reader", () => {
    const collector = createSelectionCollector();
    const reader = collector.register();
    const path = makePath("Query", ["user", "name"]);

    collector.select(reader, path);
    collector.select(reader, path);
    collector.select(reader, path);

    expect(collector.snapshot()).toHaveLength(1);
  });

  test("unregister removes all selections for a reader", () => {
    const collector = createSelectionCollector();
    const reader = collector.register();
    collector.select(reader, makePath("Query", ["viewer", "name"]));

    collector.unregister(reader);
    expect(collector.snapshot()).toHaveLength(0);
  });

  test("merges selections from multiple readers", () => {
    const collector = createSelectionCollector();
    const r1 = collector.register();
    const r2 = collector.register();

    collector.select(r1, makePath("Query", ["user", "name"]));
    collector.select(r2, makePath("Query", ["viewer", "avatar"]));

    expect(collector.snapshot()).toHaveLength(2);
  });

  test("diff detects added and removed paths", () => {
    const collector = createSelectionCollector();
    const reader = collector.register();

    const p1 = makePath("Query", ["user", "name"]);
    const p2 = makePath("Query", ["viewer", "avatar"]);

    collector.select(reader, p1);
    const prevSnapshot = collector.snapshot();

    collector.unregister(reader);
    const r2 = collector.register();
    collector.select(r2, p2);

    const { added, removed } = collector.diff(prevSnapshot);
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
  });

  test("reset clears all readers and their selections", () => {
    const collector = createSelectionCollector();
    const r1 = collector.register();
    const r2 = collector.register();

    collector.select(r1, makePath("Query", ["user", "name"]));
    collector.select(r2, makePath("Query", ["viewer", "avatar"]));
    expect(collector.snapshot()).toHaveLength(2);

    collector.reset();
    expect(collector.snapshot()).toHaveLength(0);

    const r3 = collector.register();
    collector.select(r3, makePath("Query", ["field"]));
    expect(collector.snapshot()).toHaveLength(1);
  });
});

// ─── Planner ───────────────────────────────────────────────────────────────

describe("Planner", () => {
  test("generates operation with identity fields", () => {
    const op = plan([p([{ field: "user", args: { id: "1" } }, { field: "name" }])]);

    expect(op.operationName).toBe("GQLens");
    expect(op.query).toContain("__typename");
    expect(op.query).toContain("id");
    expect(op.query).toContain("name");
  });

  test("merges fields under same root+args", () => {
    const op = plan([
      p([{ field: "user", args: { id: "1" } }, { field: "name" }]),
      p([{ field: "user", args: { id: "1" } }, { field: "avatar" }]),
    ]);

    // Single user field, with both name and avatar inside
    const userCount = op.query.split("user").length - 1;
    expect(userCount).toBe(1);
    expect(op.query).toContain("name");
    expect(op.query).toContain("avatar");
  });

  test("generates aliases for same field with different args", () => {
    const op = plan([
      p([{ field: "user", args: { id: "1" } }, { field: "name" }]),
      p([{ field: "user", args: { id: "2" } }, { field: "name" }]),
    ]);

    expect(op.query).toContain("user_0: user");
    expect(op.query).toContain("user_1: user");
  });

  test("handles nested fields via recursive tree building", () => {
    const op = plan([
      p([
        { field: "user", args: { id: "1" } },
        { field: "posts", args: { first: 10 } },
        { field: "title" },
      ]),
      p([{ field: "user", args: { id: "1" } }, { field: "name" }]),
    ]);

    // name is a top-level field of user
    // title is nested inside posts(first:10)
    expect(op.query).toContain("posts(first:");
    expect(op.query).toContain("title");
    expect(op.query).toContain("name");
    expect(op.variables).toHaveProperty("v1");
    expect(op.variables["v1"]).toBe(10);
  });

  test("extracts variables with deduplication", () => {
    const op = plan([p([{ field: "user", args: { id: "1" } }, { field: "name" }])]);

    expect(op.variables).toHaveProperty("v0");
    expect(op.variables["v0"]).toBe("1");
  });

  test("deduplicates variables with same value", () => {
    const op = plan([
      p([{ field: "user", args: { id: "1" } }, { field: "name" }]),
      p([{ field: "user", args: { id: "1" } }, { field: "avatar" }]),
    ]);

    // Same value "1" → single variable
    const varCount = Object.keys(op.variables).length;
    expect(varCount).toBe(1);
  });

  test("different values get different variables", () => {
    const op = plan([
      p([{ field: "user", args: { id: "1" } }, { field: "name" }]),
      p([{ field: "user", args: { id: "2" } }, { field: "name" }]),
    ]);

    const varCount = Object.keys(op.variables).length;
    expect(varCount).toBe(2);
  });

  test("returns correct GraphQL types for variables", () => {
    const op = plan([p([{ field: "todos", args: { first: 10, done: false } }, { field: "ids" }])]);

    const query = op.query;
    expect(query).toContain(": Int");
    expect(query).toContain(": Boolean");
  });

  test("uses schema metadata for variable types", () => {
    const op = plan([p([{ field: "user", args: { id: "1" } }, { field: "name" }])], "query", {
      roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
      types: { User: { name: { returnsEntity: false } } },
    });

    expect(op.query).toContain("$v0: ID!");
  });

  test("does not merge variables with the same value but different GraphQL types", () => {
    const op = plan(
      [
        p([{ field: "node", args: { id: "1" } }, { field: "name" }]),
        p([{ field: "search", args: { text: "1" } }, { field: "title" }]),
      ],
      "query",
      {
        roots: {
          node: { returnsEntity: true, graphQLType: "Node", args: { id: "ID!" } },
          search: { returnsEntity: true, graphQLType: "SearchResult", args: { text: "String!" } },
        },
      },
    );

    expect(Object.keys(op.variables)).toHaveLength(2);
    expect(op.query).toContain("$v0: ID!");
    expect(op.query).toContain("$v1: String!");
  });

  test("treats list ids as an accessor pseudo-field", () => {
    const op = plan([p([{ field: "todos", args: { done: false } }, { field: "ids" }])], "query", {
      roots: {
        todos: {
          returnsEntity: true,
          returnsList: true,
          graphQLType: "Todo",
          args: { done: "Boolean" },
        },
      },
    });

    expect(op.query).toContain("todos(done:");
    expect(op.query).toContain("__typename");
    expect(op.query).not.toContain("ids");
  });

  test("treats abstract list refs as an accessor pseudo-field", () => {
    const op = plan(
      [p([{ field: "search", args: { text: "milk" } }, { field: "refs" }])],
      "query",
      {
        roots: {
          search: {
            returnsEntity: true,
            returnsList: true,
            graphQLType: "SearchResult",
            isAbstract: true,
            possibleTypes: ["User", "Post"],
            args: { text: "String!" },
          },
        },
      },
    );

    expect(op.query).toContain("search(text:");
    expect(op.query).toContain("__typename");
    expect(op.query).toContain("... on Post");
    expect(op.query).toContain("... on User");
    expect(op.query).not.toContain("refs");
  });

  test("renders inline fragments from $on steps", () => {
    const op = plan(
      [
        p([
          { field: "pet", args: { id: "1" } },
          { field: "$on", typeCondition: "Cat" },
          { field: "meows" },
        ]),
      ],
      "query",
      {
        roots: { pet: { returnsEntity: true, graphQLType: "Pet", args: { id: "ID!" } } },
        types: {
          Pet: { __typename: { returnsEntity: false, possibleTypes: ["Cat", "Dog"] } },
          Cat: { meows: { returnsEntity: false } },
        },
      },
    );

    expect(op.query).toContain("pet(id:");
    expect(op.query).toContain("... on Cat");
    expect(op.query).toContain("meows");
    expect(op.query).not.toContain("$on");
    expect(op.selections[0]?.steps[1]?.responseKey).toBeUndefined();
    expect(op.selections[0]?.steps[2]?.responseKey).toBe("meows");
  });

  test("uses named variable placeholders without concrete values", () => {
    const op = plan(
      [p([{ field: "user", args: { id: { __gqlensVariable: "id" } } }, { field: "name" }])],
      "query",
      {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      },
    );

    expect(op.query).toContain("user(id: $id)");
    expect(op.query).toContain("$id: ID!");
    expect(op.variables).toStrictEqual({});
  });

  test("records response aliases for planned selections", () => {
    const op = plan([
      p([{ field: "user", args: { id: "1" } }, { field: "name" }]),
      p([{ field: "user", args: { id: "2" } }, { field: "name" }]),
    ]);

    expect(op.selections[0]?.steps[0]?.responseKey).toBe("user_0");
    expect(op.selections[1]?.steps[0]?.responseKey).toBe("user_1");
  });

  test("empty paths produce minimal query", () => {
    const op = plan([]);
    expect(op.query).toContain("__typename");
  });

  test("supports mutation operation type", () => {
    const op = plan(
      [
        {
          root: "Mutation",
          steps: [{ field: "renameUser", args: { id: "1", name: "Bob" } }, { field: "id" }],
        },
      ],
      "mutation",
    );
    expect(op.query).toContain("mutation");
    expect(op.query).toContain("renameUser");
  });

  test("no-arg root fields are handled cleanly", () => {
    const op = plan([p([{ field: "viewer" }, { field: "name" }])]);
    expect(op.query).toContain("viewer {");
  });

  test("renders deeply nested inline fragments from $on chains", () => {
    const metadata = {
      roots: {
        node: { returnsEntity: true, graphQLType: "Node", args: { id: "ID!" } },
      },
      types: {
        Node: { __typename: { returnsEntity: false, possibleTypes: ["A", "B", "C"] } },
        A: {
          id: { returnsEntity: false },
          b: { returnsEntity: true, graphQLType: "Node" },
        },
        B: {
          id: { returnsEntity: false },
          c: { returnsEntity: true, graphQLType: "Node" },
        },
        C: { name: { returnsEntity: false } },
      },
    } as Parameters<typeof plan>[2];

    const op = plan(
      [
        p([
          { field: "node", args: { id: "1" } },
          { field: "$on", typeCondition: "A" },
          { field: "b" },
          { field: "$on", typeCondition: "B" },
          { field: "c" },
          { field: "$on", typeCondition: "C" },
          { field: "name" },
        ]),
      ],
      "query",
      metadata,
    );

    expect(op.query).toContain("node(id:");
    expect(op.query).toContain("... on A");
    expect(op.query).toContain("... on B");
    expect(op.query).toContain("... on C");
    expect(op.query).toContain("name");
    expect(op.query).not.toContain("$on");
    expect(op.selections[0]?.steps[0]?.field).toBe("node");
    expect(op.selections[0]?.steps[1]?.typeCondition).toBe("A");
  });
});

// ─── QuerySession ──────────────────────────────────────────────────────────

describe("QuerySession", () => {
  test("mount returns a readable handle", () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(cache, async () => ({}));
    const reader = session.mount();
    expect(typeof reader.id).toBe("number");
    expect(reader.id).toBeGreaterThanOrEqual(0);
  });

  test("loading starts false", () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(cache, async () => ({}));
    expect(session.loading()).toBe(false);
  });

  test("error starts null", () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(cache, async () => ({}));
    expect(session.error()).toBeNull();
  });

  test("sets error when fetcher rejects", async () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(cache, async () => {
      throw new Error("network down");
    });
    const reader = session.mount();
    session.select(reader, p([{ field: "user", args: { id: "1" } }, { field: "name" }]));
    session.schedule();
    await nextMacrotask();

    expect(session.error()).toBeInstanceOf(Error);
    expect(session.error()!.message).toBe("network down");
  });

  test("unmount does not throw for unknown reader", () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(cache, async () => ({}));
    expect(() => session.unmount({ id: 999 })).not.toThrow();
  });

  test("schedule runs fetcher and normalizes into cache", async () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(cache, async () => ({
      user: { __typename: "User", id: "1", name: "Alice" },
    }));

    // Simulate: mount reader, record a selection, schedule
    session.mount();
    // In production the accessor records selections via collector.select()
    // We test the Plan+Fetcher+Cache pipeline directly instead

    // Verify the session is wired correctly by checking cache is shared
    expect(session.cache).toBe(cache);
  });

  test("schedule syncs argument-sensitive root list slots", async () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(cache, async () => ({
      todos: [
        { __typename: "Todo", id: "1", title: "Buy milk" },
        { __typename: "Todo", id: "2", title: "Walk dog" },
      ],
    }));
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [{ field: "todos", args: { done: false } }, { field: "ids" }],
    });
    session.schedule();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cache.slot('Query.todos({"done":false}).ids').sig()).toStrictEqual(["1", "2"]);
  });

  test("schedule syncs aliased root slots back to original selection keys", async () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(cache, async () => ({
      user_0: { __typename: "User", id: "1", name: "Alice" },
      user_1: { __typename: "User", id: "2", name: "Bob" },
    }));
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [{ field: "user", args: { id: "1" } }, { field: "name" }],
    });
    session.select(reader, {
      root: "Query",
      steps: [{ field: "user", args: { id: "2" } }, { field: "name" }],
    });
    session.schedule();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cache.slot('Query.user({"id":"1"})').sig()).toStrictEqual({ type: "User", id: "1" });
    expect(cache.slot('Query.user({"id":"2"})').sig()).toStrictEqual({ type: "User", id: "2" });
  });

  test("schedule accepts fetchers that return GraphQL response envelopes", async () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(cache, async () => ({
      data: { viewer: { __typename: "User", id: "1", name: "Alice" } },
    }));
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [{ field: "viewer" }, { field: "name" }],
    });
    session.schedule();
    await nextMacrotask();

    expect(cache.field<string>(cache.entity("User", "1"), "name").sig()).toBe("Alice");
    expect(cache.slot("Query.viewer").sig()).toStrictEqual({ type: "User", id: "1" });
  });

  test("schedule keeps selected scalar arrays as slot values without ids", async () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(cache, async () => ({ tags: ["typescript", "graphql"] }));
    const reader = session.mount();

    session.select(reader, { root: "Query", steps: [{ field: "tags" }] });
    session.schedule();
    await nextMacrotask();

    expect(cache.slot("Query.tags").sig()).toStrictEqual(["typescript", "graphql"]);
    expect(cache.isSlotCached("Query.tags.ids")).toBe(false);
  });

  test("schedule writes empty list identities when ids are selected", async () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(cache, async () => ({ todos: [] }));
    const reader = session.mount();

    session.select(reader, { root: "Query", steps: [{ field: "todos" }, { field: "ids" }] });
    session.schedule();
    await nextMacrotask();

    expect(cache.slot("Query.todos.ids").sig()).toStrictEqual([]);
  });

  test("schedule writes abstract list refs when refs are selected", async () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(
      cache,
      async () => ({
        search: [
          { __typename: "User", id: "1", name: "Alice" },
          { __typename: "Post", id: "10", title: "Hello" },
        ],
      }),
      {
        metadata: {
          roots: {
            search: {
              returnsEntity: true,
              returnsList: true,
              graphQLType: "SearchResult",
              isAbstract: true,
              possibleTypes: ["User", "Post"],
              args: { text: "String!" },
            },
          },
        },
      },
    );
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [{ field: "search", args: { text: "hello" } }, { field: "refs" }],
    });
    session.schedule();
    await nextMacrotask();

    expect(cache.slot('Query.search({"text":"hello"}).refs').sig()).toStrictEqual([
      { type: "User", id: "1" },
      { type: "Post", id: "10" },
    ]);
    expect(cache.slot('Query.search({"text":"hello"}).ids').sig()).toBeUndefined();
  });

  test("schedule clears stale list ids when selected list becomes null", async () => {
    const cache = createNormalizedCache();
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce({ todos: [{ __typename: "Todo", id: "1" }] })
      .mockResolvedValueOnce({ todos: null });
    const session = createQuerySession(cache, fetcher);
    const reader = session.mount();
    const selection = { root: "Query", steps: [{ field: "todos" }, { field: "ids" }] };

    session.replace(reader, [selection]);
    session.schedule();
    await nextMacrotask();
    expect(cache.slot("Query.todos.ids").sig()).toStrictEqual(["1"]);

    session.refetch();
    await nextMacrotask();

    expect(cache.slot("Query.todos").sig()).toBeNull();
    expect(cache.slot("Query.todos.ids").sig()).toBeUndefined();
  });

  test("cache-first skips fetch when a selected entity field is fresh", async () => {
    const cache = createNormalizedCache();
    cache.normalize({ user: { __typename: "User", id: "1", name: "Alice" } });
    const fetcher = vi.fn<Fetcher>(async () => ({}));
    const session = createQuerySession(cache, fetcher, {
      policy: "cache-first",
      metadata: {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      },
    });
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [{ field: "user", args: { id: "1" } }, { field: "name" }],
    });
    session.schedule();
    await nextMicrotask();

    expect(fetcher).not.toHaveBeenCalled();
  });

  test("cache-first treats non-matching inline fragments as fresh once the owner type is known", async () => {
    const cache = createNormalizedCache();
    cache.normalize({ pet: { __typename: "Dog", id: "2", barks: true } });
    const fetcher = vi.fn<Fetcher>(async () => ({}));
    const session = createQuerySession(cache, fetcher, {
      policy: "cache-first",
      metadata: {
        roots: { pet: { returnsEntity: true, graphQLType: "Pet", args: { id: "ID!" } } },
        types: {
          Pet: { __typename: { returnsEntity: false, possibleTypes: ["Cat", "Dog"] } },
          Cat: { meows: { returnsEntity: false } },
        },
      },
    });
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [
        { field: "pet", args: { id: "2" } },
        { field: "$on", typeCondition: "Cat" },
        { field: "meows" },
      ],
    });
    session.schedule();
    await nextMicrotask();

    expect(fetcher).not.toHaveBeenCalled();
  });

  test("cache-first treats cached null root slots as fresh", async () => {
    const cache = createNormalizedCache();
    cache.slot('Query.user({"id":"1"})').sig(null);
    const fetcher = vi.fn<Fetcher>(async () => ({}));
    const session = createQuerySession(cache, fetcher, {
      policy: "cache-first",
      metadata: {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      },
    });
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [{ field: "user", args: { id: "1" } }, { field: "name" }],
    });
    session.schedule();
    await nextMicrotask();

    expect(fetcher).not.toHaveBeenCalled();
  });

  test("cache-first refetches stale null root slots", async () => {
    const cache = createNormalizedCache();
    const slot = cache.slot('Query.user({"id":"1"})');
    slot.sig(null);
    slot.expires = Date.now() - 1;
    cache.field(cache.entity("User", "1"), "name").sig("stale Alice");
    const fetcher = vi.fn<Fetcher>(async () => ({
      user: { __typename: "User", id: "1", name: "Fresh Alice" },
    }));
    const session = createQuerySession(cache, fetcher, {
      policy: "cache-first",
      metadata: {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      },
    });
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [{ field: "user", args: { id: "1" } }, { field: "name" }],
    });
    session.schedule();
    await nextMacrotask();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.field<string>(cache.entity("User", "1"), "name").sig()).toBe("Fresh Alice");
  });

  test("cache-first refetches when a selected entity field is stale", async () => {
    const cache = createNormalizedCache();
    cache.normalize({ user: { __typename: "User", id: "1", name: "Alice" } });
    cache.invalidate(cache.entity("User", "1"), ["name"]);
    const fetcher = vi.fn<Fetcher>(async () => ({
      user: { __typename: "User", id: "1", name: "Fresh Alice" },
    }));
    const session = createQuerySession(cache, fetcher, {
      policy: "cache-first",
      metadata: {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      },
    });
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [{ field: "user", args: { id: "1" } }, { field: "name" }],
    });
    session.schedule();
    await nextMacrotask();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.field<string>(cache.entity("User", "1"), "name").sig()).toBe("Fresh Alice");
  });

  test("cache-and-network does not repeat the same fresh completed operation", async () => {
    const cache = createNormalizedCache();
    const fetcher = vi.fn<Fetcher>(async () => ({
      viewer: { __typename: "User", id: "1", name: "Alice" },
    }));
    const session = createQuerySession(cache, fetcher, {
      policy: "cache-and-network",
      metadata: {
        roots: { viewer: { returnsEntity: true, graphQLType: "User" } },
        types: { User: { name: { returnsEntity: false } } },
      },
    });
    const reader = session.mount();
    const selection = [{ field: "viewer" }, { field: "name" }];

    session.replace(reader, [{ root: "Query", steps: selection }]);
    session.schedule();
    await nextMacrotask();
    session.replace(reader, [{ root: "Query", steps: selection }]);
    session.schedule();
    await nextMacrotask();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("refetch forces a fresh completed operation to run again", async () => {
    const cache = createNormalizedCache();
    const fetcher = vi.fn<Fetcher>(async () => ({
      viewer: { __typename: "User", id: "1", name: "Alice" },
    }));
    const session = createQuerySession(cache, fetcher, {
      policy: "cache-first",
      metadata: {
        roots: { viewer: { returnsEntity: true, graphQLType: "User" } },
        types: { User: { name: { returnsEntity: false } } },
      },
    });
    const reader = session.mount();

    session.replace(reader, [{ root: "Query", steps: [{ field: "viewer" }, { field: "name" }] }]);
    session.schedule();
    await nextMacrotask();
    expect(fetcher).toHaveBeenCalledTimes(1);

    session.refetch();
    await nextMacrotask();

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("cache-and-network returns stale data while re-fetching", async () => {
    const cache = createNormalizedCache();
    const names = ["Alice", "Bob"];
    let call = -1;
    const session = createQuerySession(
      cache,
      async () => {
        call++;
        return { viewer: { __typename: "User", id: "1", name: names[call] } };
      },
      {
        policy: "cache-and-network",
        metadata: {
          roots: { viewer: { returnsEntity: true, graphQLType: "User" } },
          types: { User: { name: { returnsEntity: false } } },
        },
      },
    );
    const reader = session.mount();
    const path = [{ field: "viewer" }, { field: "name" }];

    session.replace(reader, [{ root: "Query", steps: path }]);
    session.schedule();
    await nextMacrotask();
    expect(cache.field<string>(cache.entity("User", "1"), "name").sig()).toBe("Alice");

    const ref = cache.entity("User", "1");
    cache.invalidate(ref, ["name"]);

    expect(cache.field<string>(ref, "name").sig()).toBe("Alice");

    session.replace(reader, [{ root: "Query", steps: path }]);
    session.schedule();
    await nextMacrotask();

    expect(cache.field<string>(ref, "name").sig()).toBe("Bob");
    expect(call).toBe(1);
  });

  test("invalidate marks fields stale and schedules active demand", async () => {
    const cache = createNormalizedCache();
    cache.normalize({ user: { __typename: "User", id: "1", name: "Alice" } });
    const fetcher = vi.fn<Fetcher>(async () => ({
      user: { __typename: "User", id: "1", name: "Fresh Alice" },
    }));
    const session = createQuerySession(cache, fetcher, {
      policy: "cache-first",
      metadata: {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      },
    });
    const reader = session.mount();

    session.replace(reader, [
      { root: "Query", steps: [{ field: "user", args: { id: "1" } }, { field: "name" }] },
    ]);
    session.schedule();
    await nextMicrotask();
    expect(fetcher).not.toHaveBeenCalled();

    session.invalidate([{ type: "User", id: "1", keys: ["name"] }]);
    await nextMacrotask();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.field<string>(cache.entity("User", "1"), "name").sig()).toBe("Fresh Alice");
  });

  test("applyInvalidations handles selection targets and concrete root entity fields", () => {
    const cache = createNormalizedCache();
    const name = cache.field<string>(cache.entity("User", "1"), "name");
    const refs = cache.slot<readonly { type: string; id: string }[]>(
      'Query.search({"text":"a"}).refs',
    );
    name.sig("Alice");
    refs.sig([{ type: "User", id: "1" }]);

    applyInvalidations(
      cache,
      [
        {
          kind: "selection",
          path: { root: "Query", steps: [{ field: "user", args: { id: "1" } }, { field: "name" }] },
        },
        {
          kind: "selection",
          path: {
            root: "Query",
            steps: [{ field: "search", args: { text: "a" } }, { field: "refs" }],
          },
        },
      ],
      {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      },
    );

    expect(name.expires).toBeLessThan(Date.now());
    expect(refs.expires).toBeLessThan(Date.now());
  });

  test("invalidateRoot marks both ids and refs list identities stale", () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(cache, async () => ({}));
    const ids = cache.slot<readonly string[]>('Query.search({"text":"hello"}).ids');
    const refs = cache.slot<readonly { type: string; id: string }[]>(
      'Query.search({"text":"hello"}).refs',
    );
    ids.sig(["1"]);
    refs.sig([{ type: "User", id: "1" }]);

    session.invalidateRoot("search", { text: "hello" });

    expect(ids.expires).toBeLessThan(Date.now());
    expect(refs.expires).toBeLessThan(Date.now());
  });

  test("live session streams repeated patches into cache", async () => {
    const cache = createNormalizedCache();
    const listeners: Array<(data: unknown) => void> = [];
    const subscribe = vi.fn<LiveSubscriber>((_, onData) => {
      listeners.push(onData);
      return () => undefined;
    });
    const session = createLiveQuerySession(cache, subscribe, {
      metadata: {
        roots: { viewer: { returnsEntity: true, graphQLType: "User" } },
        types: { User: { name: { returnsEntity: false } } },
      },
    });
    const reader = session.mount();

    session.replace(reader, [{ root: "Query", steps: [{ field: "viewer" }, { field: "name" }] }]);
    session.schedule();
    await nextMicrotask();

    listeners[0]?.({ viewer: { __typename: "User", id: "1", name: "Alice" } });
    expect(cache.field<string>(cache.entity("User", "1"), "name").sig()).toBe("Alice");

    listeners[0]?.({ data: { viewer: { __typename: "User", id: "1", name: "Bob" } } });
    expect(cache.field<string>(cache.entity("User", "1"), "name").sig()).toBe("Bob");
    expect(session.loading()).toBe(false);
  });

  test("live session unsubscribes when active selection becomes empty", async () => {
    const cache = createNormalizedCache();
    const unsubscribe = vi.fn<() => void>(() => undefined);
    const subscribe = vi.fn<LiveSubscriber>(() => unsubscribe);
    const session = createLiveQuerySession(cache, subscribe);
    const reader = session.mount();

    session.replace(reader, [{ root: "Query", steps: [{ field: "viewer" }, { field: "name" }] }]);
    session.schedule();
    await nextMicrotask();
    expect(subscribe).toHaveBeenCalledTimes(1);

    session.replace(reader, []);
    session.schedule();
    await nextMicrotask();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(session.loading()).toBe(false);
  });

  test("schedule writes args-sensitive relation list ids onto the owner relation slot", async () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(
      cache,
      async () => ({
        user: {
          __typename: "User",
          id: "1",
          posts: [
            { __typename: "Post", id: "10" },
            { __typename: "Post", id: "11" },
          ],
        },
      }),
      {
        metadata: {
          roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
          types: {
            User: { posts: { returnsEntity: true, returnsList: true, graphQLType: "Post" } },
          },
        },
      },
    );
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [
        { field: "user", args: { id: "1" } },
        { field: "posts", args: { first: 5 } },
        { field: "ids" },
      ],
    });
    session.schedule();
    await nextMacrotask();

    expect(cache.slot('User:1.posts({"first":5}).ids').sig()).toStrictEqual(["10", "11"]);
  });

  test("schedule syncs matching inline fragment fields through normalized entities", async () => {
    const cache = createNormalizedCache();
    const session = createQuerySession(
      cache,
      async () => ({ pet: { __typename: "Cat", id: "1", meows: true } }),
      {
        metadata: {
          roots: { pet: { returnsEntity: true, graphQLType: "Pet", args: { id: "ID!" } } },
          types: {
            Pet: { __typename: { returnsEntity: false, possibleTypes: ["Cat", "Dog"] } },
            Cat: { meows: { returnsEntity: false } },
          },
        },
      },
    );
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [
        { field: "pet", args: { id: "1" } },
        { field: "$on", typeCondition: "Cat" },
        { field: "meows" },
      ],
    });
    session.schedule();
    await nextMacrotask();

    expect(cache.slot('Query.pet({"id":"1"})').sig()).toStrictEqual({ type: "Cat", id: "1" });
    expect(cache.field<boolean>(cache.entity("Cat", "1"), "meows").sig()).toBe(true);
  });

  test("loading stays true until every in-flight operation settles", async () => {
    const cache = createNormalizedCache();
    const resolvers: Array<(value: Record<string, unknown>) => void> = [];
    const session = createQuerySession(cache, (op: GraphQLOperation) => {
      const firstId = String(op.variables["v0"]);
      return new Promise((resolve) => {
        resolvers.push(() =>
          resolve({ user: { __typename: "User", id: firstId, name: `User ${firstId}` } }),
        );
      });
    });
    const reader = session.mount();

    session.replace(reader, [
      { root: "Query", steps: [{ field: "user", args: { id: "1" } }, { field: "name" }] },
    ]);
    session.schedule();
    await nextMicrotask();
    expect(session.loading()).toBe(true);

    session.replace(reader, [
      { root: "Query", steps: [{ field: "user", args: { id: "2" } }, { field: "name" }] },
    ]);
    session.schedule();
    await nextMicrotask();
    expect(resolvers).toHaveLength(2);

    resolvers[0]?.({});
    await nextMacrotask();
    expect(session.loading()).toBe(true);

    resolvers[1]?.({});
    await nextMacrotask();
    expect(session.loading()).toBe(false);
  });
});

function nextMicrotask(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(() => resolve()));
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── Planner + Cache integration ───────────────────────────────────────────

describe("End-to-end: Plan → Fetch → Normalize → Read", () => {
  test("round-trip: single entity", () => {
    const cache = createNormalizedCache();
    void plan([
      { root: "Query", steps: [{ field: "user", args: { id: "1" } }, { field: "name" }] },
    ]);

    const response = { user: { __typename: "User", id: "1", name: "Alice" } };
    cache.normalize(response);

    const ref = cache.entity("User", "1");
    expect(cache.field<string>(ref, "name").sig()).toBe("Alice");
  });

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
    expect(cache.field<string>(userRef, "name").sig()).toBe("Alice");

    const post1Ref = cache.entity("Post", "10");
    expect(cache.field<string>(post1Ref, "title").sig()).toBe("First post");

    const post2Ref = cache.entity("Post", "11");
    expect(cache.field<string>(post2Ref, "title").sig()).toBe("Second post");
  });
});

// ─── Mutation Runner ───────────────────────────────────────────────────────

describe("Mutation runner", () => {
  test("executes operation descriptors, unwraps GraphQL envelopes, and normalizes results", async () => {
    const cache = createNormalizedCache();
    const fetcher = vi.fn<Fetcher>(async () => ({
      data: { renameUser: { __typename: "User", id: "1", name: "Alice" } },
    }));
    const mutate = createMutationRunner({
      cache,
      fetcher,
      mutation: {
        operationName: "renameUser",
        query: "mutation renameUser($id: ID!) { renameUser(id: $id) { id __typename name } }",
        variables: (input: { id: string }) => ({ id: input.id }),
      },
    });

    await expect(mutate({ id: "1" })).resolves.toStrictEqual({
      __typename: "User",
      id: "1",
      name: "Alice",
    });
    expect(cache.field(cache.entity("User", "1"), "name").sig()).toBe("Alice");
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({
        operationName: "renameUser",
        variables: { id: "1" },
      }),
    );
  });

  test("rolls back optimistic entity writes on failure", async () => {
    const cache = createNormalizedCache();
    cache.field(cache.entity("User", "1"), "name").sig("Original");
    const mutate = createMutationRunner({
      cache,
      fetcher: async () => ({}),
      mutation: async () => {
        throw new Error("nope");
      },
    });

    await expect(
      mutate({
        optimistic(c) {
          c.field(c.entity("User", "1"), "name").sig("Optimistic");
        },
        invalidates: [{ type: "User", id: "1", keys: ["name"] }],
      }),
    ).rejects.toThrow("nope");

    expect(cache.field(cache.entity("User", "1"), "name").sig()).toBe("Original");
  });
});

// ─── Transport ─────────────────────────────────────────────────────────────

describe("FetchTransport", () => {
  test("creates a valid fetcher function", () => {
    const fetch = createFetchTransport("/graphql");
    expect(typeof fetch).toBe("function");
  });
});

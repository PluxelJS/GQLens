import { describe, expect, test, vi } from "vitest";
import {
  applyInvalidations,
  createLiveQuerySession,
  createGraphDataStore,
  createQuerySession,
  type Fetcher,
  type GraphQLOperation,
  type LiveSubscriber,
  type SelectionPath,
  type SelectionStep,
} from "@gqlens/core";
import { cacheField, cacheSlot, isCacheSlotFresh, peekCacheSlot } from "./cache-helpers";

const p = (steps: SelectionStep[]): SelectionPath => ({
  root: "Query",
  steps,
});

// ─── QuerySession ──────────────────────────────────────────────────────────

describe("QuerySession", () => {
  test("sets error when fetcher rejects", async () => {
    const cache = createGraphDataStore();
    const session = createQuerySession({
      store: cache,
      fetcher: async () => {
        throw new Error("network down");
      },
    });
    const reader = session.mount();
    session.select(reader, p([{ field: "user", args: { id: "1" } }, { field: "name" }]));
    session.schedule();
    await nextMacrotask();

    expect(session.error()).toBeInstanceOf(Error);
    expect(session.error()!.message).toBe("network down");
  });

  test("schedule syncs argument-sensitive root list slots", async () => {
    const cache = createGraphDataStore();
    const session = createQuerySession({
      store: cache,
      fetcher: async () => ({
        todos: [
          { __typename: "Todo", id: "1", title: "Buy milk" },
          { __typename: "Todo", id: "2", title: "Walk dog" },
        ],
      }),
    });
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [{ field: "todos", args: { done: false } }, { field: "ids" }],
    });
    session.schedule();
    await nextMacrotask();

    expect(cacheSlot(cache, 'Query.todos({"done":false}).ids').sig()).toStrictEqual(["1", "2"]);
  });

  test("schedule syncs aliased root slots back to original selection keys", async () => {
    const cache = createGraphDataStore();
    const session = createQuerySession({
      store: cache,
      fetcher: async () => ({
        user_0: { __typename: "User", id: "1", name: "Alice" },
        user_1: { __typename: "User", id: "2", name: "Bob" },
      }),
    });
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
    await nextMacrotask();

    expect(cacheSlot(cache, 'Query.user({"id":"1"})').sig()).toStrictEqual({
      type: "User",
      id: "1",
    });
    expect(cacheSlot(cache, 'Query.user({"id":"2"})').sig()).toStrictEqual({
      type: "User",
      id: "2",
    });
  });

  test("schedule accepts fetchers that return GraphQL response envelopes", async () => {
    const cache = createGraphDataStore();
    const session = createQuerySession({
      store: cache,
      fetcher: async () => ({
        data: { viewer: { __typename: "User", id: "1", name: "Alice" } },
      }),
    });
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [{ field: "viewer" }, { field: "name" }],
    });
    session.schedule();
    await nextMacrotask();

    expect(cacheField<string>(cache, cache.entity("User", "1"), "name").sig()).toBe("Alice");
    expect(cacheSlot(cache, "Query.viewer").sig()).toStrictEqual({ type: "User", id: "1" });
  });

  test("schedule keeps selected scalar arrays as slot values without ids", async () => {
    const cache = createGraphDataStore();
    const session = createQuerySession({
      store: cache,
      fetcher: async () => ({ tags: ["typescript", "graphql"] }),
    });
    const reader = session.mount();

    session.select(reader, { root: "Query", steps: [{ field: "tags" }] });
    session.schedule();
    await nextMacrotask();

    expect(cacheSlot(cache, "Query.tags").sig()).toStrictEqual(["typescript", "graphql"]);
    expect(isCacheSlotFresh(cache, "Query.tags.ids")).toBe(false);
    expect(peekCacheSlot(cache, "Query.tags.ids")).toBeUndefined();
    expect(peekCacheSlot(cache, "Query.tags.refs")).toBeUndefined();
  });

  test("schedule writes empty list ids when ids are selected", async () => {
    const cache = createGraphDataStore();
    const session = createQuerySession({
      store: cache,
      fetcher: async () => ({ todos: [] }),
    });
    const reader = session.mount();

    session.select(reader, { root: "Query", steps: [{ field: "todos" }, { field: "ids" }] });
    session.schedule();
    await nextMacrotask();

    expect(cacheSlot(cache, "Query.todos.ids").sig()).toStrictEqual([]);
  });

  test("schedule writes abstract list refs when refs are selected", async () => {
    const cache = createGraphDataStore();
    const session = createQuerySession({
      store: cache,
      fetcher: async () => ({
        search: [
          { __typename: "User", id: "1", name: "Alice" },
          { __typename: "Post", id: "10", title: "Hello" },
        ],
      }),
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
    });
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [{ field: "search", args: { text: "hello" } }, { field: "refs" }],
    });
    session.schedule();
    await nextMacrotask();

    expect(cacheSlot(cache, 'Query.search({"text":"hello"}).refs').sig()).toStrictEqual([
      { type: "User", id: "1" },
      { type: "Post", id: "10" },
    ]);
    expect(cacheSlot(cache, 'Query.search({"text":"hello"}).ids').sig()).toBeUndefined();
  });

  test("schedule clears stale list ids when selected list becomes null", async () => {
    const cache = createGraphDataStore();
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce({ todos: [{ __typename: "Todo", id: "1" }] })
      .mockResolvedValueOnce({ todos: null });
    const session = createQuerySession({
      store: cache,
      fetcher,
    });
    const reader = session.mount();
    const selection = { root: "Query", steps: [{ field: "todos" }, { field: "ids" }] };

    session.replace(reader, [selection]);
    session.schedule();
    await nextMacrotask();
    expect(cacheSlot(cache, "Query.todos.ids").sig()).toStrictEqual(["1"]);

    session.refetch();
    await nextMacrotask();

    expect(cacheSlot(cache, "Query.todos").sig()).toBeNull();
    expect(cacheSlot(cache, "Query.todos.ids").sig()).toBeUndefined();
  });

  test("cache-first skips fetch when a selected entity field is fresh", async () => {
    const cache = createGraphDataStore();
    cache.normalize({ user: { __typename: "User", id: "1", name: "Alice" } });
    const fetcher = vi.fn<Fetcher>(async () => ({}));
    const session = createQuerySession({
      store: cache,
      fetcher,
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

  test("schedule writes embedded value object leaves under the owning entity", async () => {
    const cache = createGraphDataStore();
    const session = createQuerySession({
      store: cache,
      fetcher: async () => ({
        user: {
          __typename: "User",
          id: "1",
          status: { online: true, source: { kind: "hmr" } },
        },
      }),
      metadata: valueObjectMetadata(),
    });
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [
        { field: "user", args: { id: "1" } },
        { field: "status" },
        { field: "source" },
        { field: "kind" },
      ],
    });
    session.schedule();
    await nextMacrotask();

    expect(cacheField<string>(cache, cache.entity("User", "1"), "status.source.kind").sig()).toBe(
      "hmr",
    );
    expect(cacheField<boolean>(cache, cache.entity("User", "1"), "status.online").sig()).toBe(true);
  });

  test("schedule clears embedded value object leaves when the value becomes null", async () => {
    const cache = createGraphDataStore();
    cache.normalize(
      {
        user: {
          __typename: "User",
          id: "1",
          status: { online: true, source: { kind: "hmr" } },
        },
      },
      0,
      valueObjectMetadata(),
    );
    cache.normalize(
      {
        user: {
          __typename: "User",
          id: "1",
          status: null,
        },
      },
      0,
      valueObjectMetadata(),
    );

    expect(cacheField(cache, cache.entity("User", "1"), "status.online").sig()).toBeUndefined();
    expect(
      cacheField(cache, cache.entity("User", "1"), "status.source.kind").sig(),
    ).toBeUndefined();
  });

  test("cache-first skips fetch when a selected embedded value object leaf is fresh", async () => {
    const cache = createGraphDataStore();
    cache.normalize(
      {
        user: {
          __typename: "User",
          id: "1",
          status: { online: true, source: { kind: "hmr" } },
        },
      },
      0,
      valueObjectMetadata(),
    );
    const fetcher = vi.fn<Fetcher>(async () => ({}));
    const session = createQuerySession({
      store: cache,
      fetcher,
      policy: "cache-first",
      metadata: valueObjectMetadata(),
    });
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [
        { field: "user", args: { id: "1" } },
        { field: "status" },
        { field: "source" },
        { field: "kind" },
      ],
    });
    session.schedule();
    await nextMicrotask();

    expect(fetcher).not.toHaveBeenCalled();
  });

  test("cache-first skips fetch when a root value object list ids slot is fresh", async () => {
    const cache = createGraphDataStore();
    const metadata = {
      roots: {
        pluginStatus: {
          returnsEntity: false,
          graphQLType: "PluginStatusOverview",
          targetObjectKind: "value",
        },
      },
      types: {
        PluginStatusOverview: {
          plugins: {
            returnsEntity: true,
            returnsList: true,
            graphQLType: "Plugin",
            targetObjectKind: "entity",
          },
        },
        Plugin: {
          name: { returnsEntity: false },
        },
      },
    } as const;
    cache.normalize(
      {
        pluginStatus: {
          plugins: [{ __typename: "Plugin", id: "core", name: "core" }],
        },
      },
      0,
      metadata,
    );
    const fetcher = vi.fn<Fetcher>(async () => ({}));
    const session = createQuerySession({
      store: cache,
      fetcher,
      policy: "cache-first",
      metadata,
    });
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [{ field: "pluginStatus" }, { field: "plugins" }, { field: "ids" }],
    });
    session.schedule();
    await nextMicrotask();

    expect(cacheSlot(cache, "Query.pluginStatus.plugins.ids").sig()).toStrictEqual(["core"]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("cache-first skips fetch when an entity-owned value object list ids slot is fresh", async () => {
    const cache = createGraphDataStore();
    const metadata = {
      roots: {
        plugin: {
          returnsEntity: true,
          graphQLType: "Plugin",
          targetObjectKind: "entity",
          args: { id: "ID!" },
        },
      },
      types: {
        Plugin: {
          detail: {
            returnsEntity: false,
            graphQLType: "PluginDetail",
            targetObjectKind: "value",
          },
          name: { returnsEntity: false },
        },
        PluginDetail: {
          dependencies: {
            returnsEntity: true,
            returnsList: true,
            graphQLType: "Plugin",
            targetObjectKind: "entity",
          },
        },
      },
    } as const;
    cache.normalize(
      {
        plugin: {
          __typename: "Plugin",
          id: "core",
          name: "core",
          detail: {
            dependencies: [{ __typename: "Plugin", id: "runtime", name: "runtime" }],
          },
        },
      },
      0,
      metadata,
    );
    const fetcher = vi.fn<Fetcher>(async () => ({}));
    const session = createQuerySession({
      store: cache,
      fetcher,
      policy: "cache-first",
      metadata,
    });
    const reader = session.mount();

    session.select(reader, {
      root: "Query",
      steps: [
        { field: "plugin", args: { id: "core" } },
        { field: "detail" },
        { field: "dependencies" },
        { field: "ids" },
      ],
    });
    session.schedule();
    await nextMicrotask();

    expect(cacheSlot(cache, "Plugin:core.detail.dependencies.ids").sig()).toStrictEqual([
      "runtime",
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("cache-first fetches value object list ids only once after normalization", async () => {
    const cache = createGraphDataStore();
    const metadata = {
      roots: {
        pluginStatus: {
          returnsEntity: false,
          graphQLType: "PluginStatusOverview",
          targetObjectKind: "value",
        },
      },
      types: {
        PluginStatusOverview: {
          plugins: {
            returnsEntity: true,
            returnsList: true,
            graphQLType: "Plugin",
            targetObjectKind: "entity",
          },
        },
        Plugin: {
          name: { returnsEntity: false },
        },
      },
    } as const;
    const fetcher = vi.fn<Fetcher>(async () => ({
      pluginStatus: {
        plugins: [{ __typename: "Plugin", id: "core", name: "core" }],
      },
    }));
    const session = createQuerySession({
      store: cache,
      fetcher,
      policy: "cache-first",
      metadata,
    });
    const reader = session.mount();
    const selection = {
      root: "Query",
      steps: [{ field: "pluginStatus" }, { field: "plugins" }, { field: "ids" }],
    };

    session.replace(reader, [selection]);
    session.schedule();
    await nextMacrotask();
    session.schedule();
    await nextMicrotask();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(peekCacheSlot(cache, "Query.missing")).toBeUndefined();
  });

  test("cache-first does not repeat a completed operation within ttl after a freshness false-negative", async () => {
    const cache = createGraphDataStore();
    const fetcher = vi.fn<Fetcher>(async () => ({}));
    const session = createQuerySession({
      store: cache,
      fetcher,
      policy: "cache-first",
      ttl: 30000,
    });
    const reader = session.mount();
    const selection = { root: "Query", steps: [{ field: "missing" }, { field: "value" }] };

    session.replace(reader, [selection]);
    session.schedule();
    await nextMacrotask();
    session.schedule();
    await nextMicrotask();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("cache-first refetches stale fields after a completed fresh operation", async () => {
    const cache = createGraphDataStore();
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce({
        user: { __typename: "User", id: "1", name: "Alice" },
      })
      .mockResolvedValueOnce({
        user: { __typename: "User", id: "1", name: "Fresh Alice" },
      });
    const session = createQuerySession({
      store: cache,
      fetcher,
      policy: "cache-first",
      ttl: 30000,
      metadata: {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      },
    });
    const reader = session.mount();
    const selection = {
      root: "Query",
      steps: [{ field: "user", args: { id: "1" } }, { field: "name" }],
    };

    session.replace(reader, [selection]);
    session.schedule();
    await nextMacrotask();
    cache.invalidate({
      kind: "entity",
      ref: cache.entity("User", "1"),
      paths: [[{ field: "name" }]],
    });
    session.schedule();
    await nextMacrotask();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cacheField<string>(cache, cache.entity("User", "1"), "name").sig()).toBe("Fresh Alice");
  });

  test("cache-first treats non-matching inline fragments as fresh once the owner type is known", async () => {
    const cache = createGraphDataStore();
    cache.normalize({ pet: { __typename: "Dog", id: "2", barks: true } });
    const fetcher = vi.fn<Fetcher>(async () => ({}));
    const session = createQuerySession({
      store: cache,
      fetcher,
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
    const cache = createGraphDataStore();
    cacheSlot(cache, 'Query.user({"id":"1"})').sig(null);
    const fetcher = vi.fn<Fetcher>(async () => ({}));
    const session = createQuerySession({
      store: cache,
      fetcher,
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
    const cache = createGraphDataStore();
    const slot = cacheSlot(cache, 'Query.user({"id":"1"})');
    slot.sig(null);
    slot.expires = Date.now() - 1;
    cacheField(cache, cache.entity("User", "1"), "name").sig("stale Alice");
    const fetcher = vi.fn<Fetcher>(async () => ({
      user: { __typename: "User", id: "1", name: "Fresh Alice" },
    }));
    const session = createQuerySession({
      store: cache,
      fetcher,
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
    expect(cacheField<string>(cache, cache.entity("User", "1"), "name").sig()).toBe("Fresh Alice");
  });

  test("cache-first refetches when a selected entity field is stale", async () => {
    const cache = createGraphDataStore();
    cache.normalize({ user: { __typename: "User", id: "1", name: "Alice" } });
    cache.invalidate({
      kind: "entity",
      ref: cache.entity("User", "1"),
      paths: [[{ field: "name" }]],
    });
    const fetcher = vi.fn<Fetcher>(async () => ({
      user: { __typename: "User", id: "1", name: "Fresh Alice" },
    }));
    const session = createQuerySession({
      store: cache,
      fetcher,
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
    expect(cacheField<string>(cache, cache.entity("User", "1"), "name").sig()).toBe("Fresh Alice");
  });

  test("cache-and-network does not repeat the same fresh completed operation", async () => {
    const cache = createGraphDataStore();
    const fetcher = vi.fn<Fetcher>(async () => ({
      viewer: { __typename: "User", id: "1", name: "Alice" },
    }));
    const session = createQuerySession({
      store: cache,
      fetcher,
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

  test("cache-and-network repeats fresh operations after completed ttl expires", async () => {
    const cache = createGraphDataStore();
    const metadata = {
      roots: { viewer: { returnsEntity: true, graphQLType: "User" } },
      types: { User: { name: { returnsEntity: false } } },
    } as const;
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce({
        viewer: { __typename: "User", id: "1", name: "Alice" },
      })
      .mockResolvedValueOnce({
        viewer: { __typename: "User", id: "1", name: "Fresh Alice" },
      });
    const session = createQuerySession({
      store: cache,
      fetcher,
      policy: "cache-and-network",
      ttl: 1,
      metadata,
    });
    const reader = session.mount();
    const selection = [{ field: "viewer" }, { field: "name" }];

    session.replace(reader, [{ root: "Query", steps: selection }]);
    session.schedule();
    await nextMacrotask();
    await new Promise((resolve) => setTimeout(resolve, 5));
    cache.normalize(
      { viewer: { __typename: "User", id: "1", name: "Externally Fresh Alice" } },
      30_000,
      metadata,
    );
    session.schedule();
    await nextMacrotask();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cacheField<string>(cache, cache.entity("User", "1"), "name").sig()).toBe("Fresh Alice");
  });

  test("refetch forces a fresh completed operation to run again", async () => {
    const cache = createGraphDataStore();
    const fetcher = vi.fn<Fetcher>(async () => ({
      viewer: { __typename: "User", id: "1", name: "Alice" },
    }));
    const session = createQuerySession({
      store: cache,
      fetcher,
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
    const cache = createGraphDataStore();
    const names = ["Alice", "Bob"];
    let call = -1;
    const session = createQuerySession({
      store: cache,
      fetcher: async () => {
        call++;
        return { viewer: { __typename: "User", id: "1", name: names[call] } };
      },
      policy: "cache-and-network",
      metadata: {
        roots: { viewer: { returnsEntity: true, graphQLType: "User" } },
        types: { User: { name: { returnsEntity: false } } },
      },
    });
    const reader = session.mount();
    const path = [{ field: "viewer" }, { field: "name" }];

    session.replace(reader, [{ root: "Query", steps: path }]);
    session.schedule();
    await nextMacrotask();
    expect(cacheField<string>(cache, cache.entity("User", "1"), "name").sig()).toBe("Alice");

    const ref = cache.entity("User", "1");
    cache.invalidate({ kind: "entity", ref, paths: [[{ field: "name" }]] });

    expect(cacheField<string>(cache, ref, "name").sig()).toBe("Alice");

    session.replace(reader, [{ root: "Query", steps: path }]);
    session.schedule();
    await nextMacrotask();

    expect(cacheField<string>(cache, ref, "name").sig()).toBe("Bob");
    expect(call).toBe(1);
  });

  test("invalidate marks fields stale and schedules active demand", async () => {
    const cache = createGraphDataStore();
    cache.normalize({ user: { __typename: "User", id: "1", name: "Alice" } });
    const fetcher = vi.fn<Fetcher>(async () => ({
      user: { __typename: "User", id: "1", name: "Fresh Alice" },
    }));
    const session = createQuerySession({
      store: cache,
      fetcher,
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

    session.invalidate([
      {
        kind: "entity",
        ref: { type: "User", id: "1" },
        paths: [[{ field: "name" }]],
      },
    ]);
    await nextMacrotask();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cacheField<string>(cache, cache.entity("User", "1"), "name").sig()).toBe("Fresh Alice");
  });

  test("applyInvalidations handles selection targets and concrete root entity fields", () => {
    const cache = createGraphDataStore();
    const name = cacheField<string>(cache, cache.entity("User", "1"), "name");
    const refs = cacheSlot<readonly { type: string; id: string }[]>(
      cache,
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

  test("applyInvalidations marks embedded value object leaf fields stale", () => {
    const cache = createGraphDataStore();
    const status = cacheField<string>(cache, cache.entity("User", "1"), "status.source.kind");
    status.sig("hmr");

    applyInvalidations(
      cache,
      [
        {
          kind: "selection",
          path: {
            root: "Query",
            steps: [
              { field: "user", args: { id: "1" } },
              { field: "status" },
              { field: "source" },
              { field: "kind" },
            ],
          },
        },
      ],
      valueObjectMetadata(),
    );

    expect(status.expires).toBeLessThan(Date.now());
  });

  test("applyInvalidations marks entity-owned list relation slots stale", () => {
    const cache = createGraphDataStore();
    const posts = cacheSlot<readonly string[]>(cache, "User:1.posts.ids");
    posts.sig(["10"]);

    applyInvalidations(
      cache,
      [
        {
          kind: "selection",
          path: {
            root: "Query",
            steps: [{ field: "user", args: { id: "1" } }, { field: "posts" }, { field: "ids" }],
          },
        },
      ],
      {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: {
          User: {
            posts: { returnsEntity: true, returnsList: true, graphQLType: "Post" },
          },
        },
      },
    );

    expect(posts.expires).toBeLessThan(Date.now());
  });

  test("root invalidation marks both ids and refs list slots stale", () => {
    const cache = createGraphDataStore();
    const session = createQuerySession({
      store: cache,
      fetcher: async () => ({}),
    });
    const ids = cacheSlot<readonly string[]>(cache, 'Query.search({"text":"hello"}).ids');
    const refs = cacheSlot<readonly { type: string; id: string }[]>(
      cache,
      'Query.search({"text":"hello"}).refs',
    );
    ids.sig(["1"]);
    refs.sig([{ type: "User", id: "1" }]);

    session.invalidate([
      {
        kind: "root",
        root: "Query",
        paths: [[{ field: "search", args: { text: "hello" } }]],
      },
    ]);

    expect(ids.expires).toBeLessThan(Date.now());
    expect(refs.expires).toBeLessThan(Date.now());
  });

  test("live session streams repeated patches into cache", async () => {
    const cache = createGraphDataStore();
    const listeners: Array<(data: unknown) => void> = [];
    const subscribe = vi.fn<LiveSubscriber>((_, onData) => {
      listeners.push(onData);
      return () => undefined;
    });
    const session = createLiveQuerySession({
      store: cache,
      subscriber: subscribe,
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
    expect(cacheField<string>(cache, cache.entity("User", "1"), "name").sig()).toBe("Alice");

    listeners[0]?.({ data: { viewer: { __typename: "User", id: "1", name: "Bob" } } });
    expect(cacheField<string>(cache, cache.entity("User", "1"), "name").sig()).toBe("Bob");
    expect(session.loading()).toBe(false);
  });

  test("live session unsubscribes when active selection becomes empty", async () => {
    const cache = createGraphDataStore();
    const unsubscribe = vi.fn<() => void>(() => undefined);
    const subscribe = vi.fn<LiveSubscriber>(() => unsubscribe);
    const session = createLiveQuerySession({
      store: cache,
      subscriber: subscribe,
    });
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

  test("live session sets error when subscribe throws synchronously", async () => {
    const cache = createGraphDataStore();
    const session = createLiveQuerySession({
      store: cache,
      subscriber: () => {
        throw new Error("subscribe failed");
      },
    });
    const reader = session.mount();

    session.replace(reader, [{ root: "Query", steps: [{ field: "viewer" }, { field: "name" }] }]);
    session.schedule();
    await nextMicrotask();

    expect(session.error()).toBeInstanceOf(Error);
    expect(session.error()!.message).toBe("subscribe failed");
    expect(session.loading()).toBe(false);
  });

  test("live session sets error when subscribe fires onError", async () => {
    const cache = createGraphDataStore();
    let onErrorRef: ((reason: Error) => void) | undefined;
    const session = createLiveQuerySession({
      store: cache,
      subscriber: (_op, _onData, onError) => {
        onErrorRef = onError;
        return () => undefined;
      },
    });
    const reader = session.mount();

    session.replace(reader, [{ root: "Query", steps: [{ field: "viewer" }, { field: "name" }] }]);
    session.schedule();
    await nextMicrotask();

    onErrorRef?.(new Error("connection lost"));

    expect(session.error()).toBeInstanceOf(Error);
    expect(session.error()!.message).toBe("connection lost");
    expect(session.loading()).toBe(false);
  });

  test("schedule writes args-sensitive relation list ids onto the owner relation slot", async () => {
    const cache = createGraphDataStore();
    const session = createQuerySession({
      store: cache,
      fetcher: async () => ({
        user: {
          __typename: "User",
          id: "1",
          posts: [
            { __typename: "Post", id: "10" },
            { __typename: "Post", id: "11" },
          ],
        },
      }),
      metadata: {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: {
          User: { posts: { returnsEntity: true, returnsList: true, graphQLType: "Post" } },
        },
      },
    });
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

    expect(cacheSlot(cache, 'User:1.posts({"first":5}).ids').sig()).toStrictEqual(["10", "11"]);
  });

  test("schedule syncs matching inline fragment fields through normalized entities", async () => {
    const cache = createGraphDataStore();
    const session = createQuerySession({
      store: cache,
      fetcher: async () => ({ pet: { __typename: "Cat", id: "1", meows: true } }),
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
        { field: "pet", args: { id: "1" } },
        { field: "$on", typeCondition: "Cat" },
        { field: "meows" },
      ],
    });
    session.schedule();
    await nextMacrotask();

    expect(cacheSlot(cache, 'Query.pet({"id":"1"})').sig()).toStrictEqual({ type: "Cat", id: "1" });
    expect(cacheField<boolean>(cache, cache.entity("Cat", "1"), "meows").sig()).toBe(true);
  });

  test("loading stays true until every in-flight operation settles", async () => {
    const cache = createGraphDataStore();
    const resolvers: Array<(value: Record<string, unknown>) => void> = [];
    const session = createQuerySession({
      store: cache,
      fetcher: (op: GraphQLOperation) => {
        const firstId = String(op.variables["v0"]);
        return new Promise((resolve) => {
          resolvers.push(() =>
            resolve({ user: { __typename: "User", id: firstId, name: `User ${firstId}` } }),
          );
        });
      },
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

  test("ignores stale responses from older in-flight operations", async () => {
    const cache = createGraphDataStore();
    const resolvers: Array<(value: Record<string, unknown>) => void> = [];
    const session = createQuerySession({
      store: cache,
      fetcher: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
      metadata: {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: {
          User: {
            name: { returnsEntity: false },
            avatar: { returnsEntity: false },
          },
        },
      },
    });
    const reader = session.mount();

    session.replace(reader, [
      { root: "Query", steps: [{ field: "user", args: { id: "1" } }, { field: "name" }] },
    ]);
    session.schedule();
    await nextMicrotask();
    session.replace(reader, [
      { root: "Query", steps: [{ field: "user", args: { id: "1" } }, { field: "name" }] },
      { root: "Query", steps: [{ field: "user", args: { id: "1" } }, { field: "avatar" }] },
    ]);
    session.schedule();
    await nextMicrotask();

    resolvers[1]?.({
      user: { __typename: "User", id: "1", name: "Bob", avatar: "bob.png" },
    });
    await nextMacrotask();
    resolvers[0]?.({
      user: { __typename: "User", id: "1", name: "Alice" },
    });
    await nextMacrotask();

    expect(cacheField<string>(cache, cache.entity("User", "1"), "name").sig()).toBe("Bob");
    expect(cacheField<string>(cache, cache.entity("User", "1"), "avatar").sig()).toBe("bob.png");
    expect(session.loading()).toBe(false);
  });

  test("ignores stale errors from older in-flight operations", async () => {
    const cache = createGraphDataStore();
    const deferred: Array<{
      readonly resolve: (value: Record<string, unknown>) => void;
      readonly reject: (reason: unknown) => void;
    }> = [];
    const session = createQuerySession({
      store: cache,
      fetcher: () =>
        new Promise((resolve, reject) => {
          deferred.push({ resolve, reject });
        }),
      metadata: {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: {
          User: {
            name: { returnsEntity: false },
            avatar: { returnsEntity: false },
          },
        },
      },
    });
    const reader = session.mount();

    session.replace(reader, [
      { root: "Query", steps: [{ field: "user", args: { id: "1" } }, { field: "name" }] },
    ]);
    session.schedule();
    await nextMicrotask();
    session.replace(reader, [
      { root: "Query", steps: [{ field: "user", args: { id: "1" } }, { field: "name" }] },
      { root: "Query", steps: [{ field: "user", args: { id: "1" } }, { field: "avatar" }] },
    ]);
    session.schedule();
    await nextMicrotask();

    deferred[1]?.resolve({
      user: { __typename: "User", id: "1", name: "Bob", avatar: "bob.png" },
    });
    await nextMacrotask();
    deferred[0]?.reject(new Error("old network failure"));
    await nextMacrotask();

    expect(session.error()).toBeNull();
    expect(cacheField<string>(cache, cache.entity("User", "1"), "name").sig()).toBe("Bob");
    expect(session.loading()).toBe(false);
  });
});

function nextMicrotask(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(() => resolve()));
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function valueObjectMetadata() {
  return {
    roots: {
      user: {
        returnsEntity: true,
        graphQLType: "User",
        targetObjectKind: "entity",
        args: { id: "ID!" },
      },
    },
    types: {
      User: {
        status: {
          returnsEntity: false,
          graphQLType: "UserStatus",
          targetObjectKind: "value",
        },
      },
      UserStatus: {
        online: { returnsEntity: false },
        source: {
          returnsEntity: false,
          graphQLType: "StatusSource",
          targetObjectKind: "value",
        },
      },
      StatusSource: {
        kind: { returnsEntity: false },
      },
    },
  } as const;
}

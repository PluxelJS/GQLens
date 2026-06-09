import { describe, expect, test, vi, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createQuery, createLiveQuery, createMutation, createPreparedQuery } from "@gqlens/solid";
import {
  createNormalizedCache,
  createSignal,
  type Fetcher,
  type LiveSubscriber,
  type PreparedSelection,
} from "@gqlens/core";
import { cacheField, cacheSlot } from "../../core/test/cache-helpers";

const userNameSelection: PreparedSelection = {
  variables: ["id"],
  paths: [
    {
      root: "Query",
      steps: [{ field: "user", args: { id: { __gqlensVariable: "id" } } }, { field: "name" }],
    },
  ],
};

describe("Solid adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createQuery", () => {
    test("returns session state with loading and error accessors", () => {
      const state = createQuery({ endpoint: "/graphql" });
      expect(state.loading()).toBe(false);
      expect(state.error()).toBeNull();
      expect(state.session).toBeDefined();
      expect(state.cache).toBeDefined();
    });

    test("accepts custom config", () => {
      const state = createQuery({
        endpoint: "/graphql",
        policy: "network-only",
        ttl: 10000,
      });
      expect(state.session).toBeDefined();
      expect(state.loading()).toBe(false);
    });

    test("uses default endpoint when none provided", () => {
      const state = createQuery();
      expect(state.loading()).toBe(false);
      expect(state.error()).toBeNull();
    });

    test("exposes reader scope", () => {
      const state = createQuery({ endpoint: "/graphql" });
      const sig = createSignal("hello");
      expect(state.read(sig)).toBe("hello");
      expect(() => state.demand("Query", [{ field: "viewer" }])).not.toThrow();
    });

    test("schedules demanded selections in the same microtask", async () => {
      const fetcher = vi.fn<Fetcher>(async () => ({
        viewer: { __typename: "User", id: "1", name: "Alice" },
      }));
      const state = createQuery({ fetcher, policy: "network-only" });

      state.demand("Query", [{ field: "viewer" }, { field: "name" }]);
      await nextMacrotask();

      expect(fetcher).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining("viewer"),
        }),
      );
    });

    test("reads current loading state from session signals", async () => {
      const resolvers: Array<(value: Record<string, unknown>) => void> = [];
      const fetcher = vi.fn<Fetcher>(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          }),
      );
      const scope = createRoot((dispose) => {
        const state = createQuery({ fetcher, policy: "network-only" });
        state.demand("Query", [{ field: "viewer" }, { field: "name" }]);
        state.session.schedule();
        return { dispose, state };
      });

      await nextMacrotask();
      expect(resolvers).toHaveLength(1);
      expect(scope.state.loading()).toBe(true);

      resolvers[0]!({ viewer: { __typename: "User", id: "1", name: "Alice" } });
      await nextMacrotask();

      expect(scope.state.loading()).toBe(false);
      scope.dispose();
    });
  });

  describe("createPreparedQuery", () => {
    test("demands bound prepared selection paths", async () => {
      const fetcher = vi.fn<Fetcher>(async () => ({
        user: { __typename: "User", id: "1", name: "Alice" },
      }));

      createPreparedQuery(userNameSelection, { id: "1" }, { fetcher, policy: "network-only" });
      await nextMacrotask();

      expect(fetcher).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: { v0: "1" },
        }),
      );
    });
  });

  describe("createLiveQuery", () => {
    test("returns session state", () => {
      const state = createLiveQuery({ endpoint: "/graphql" });
      expect(state.loading()).toBe(false);
      expect(state.error()).toBeNull();
      expect(state.session).toBeDefined();
    });

    test("accepts an external live subscriber", async () => {
      const cache = createNormalizedCache();
      const listeners: Array<(data: unknown) => void> = [];
      const liveSubscriber = vi.fn<LiveSubscriber>((_, onData) => {
        listeners.push(onData);
        return () => undefined;
      });
      const state = createLiveQuery({
        cache,
        live: { subscriber: liveSubscriber },
        metadata: {
          roots: { viewer: { returnsEntity: true, graphQLType: "User" } },
          types: { User: { name: { returnsEntity: false } } },
        },
      });

      state.demand("Query", [{ field: "viewer" }, { field: "name" }]);
      state.session.schedule();
      await nextMacrotask();
      expect(liveSubscriber).toHaveBeenCalledTimes(1);

      listeners[0]?.({ viewer: { __typename: "User", id: "1", name: "Alice" } });
      expect(cacheField(cache, cache.entity("User", "1"), "name").sig()).toBe("Alice");
    });
  });

  describe("createMutation", () => {
    test("returns a callable async function", async () => {
      const cache = createNormalizedCache();
      const mutate = createMutation(
        async (input: { name: string }) => ({ success: true, ...input }),
        { cache },
      );

      expect(typeof mutate).toBe("function");
    });

    test("normalizes server response into cache", async () => {
      const cache = createNormalizedCache();
      const mutate = createMutation(
        async (input: { name: string }) => ({
          renameUser: { __typename: "User", id: "1", name: input.name },
        }),
        { cache },
      );

      await mutate({ name: "Bob" });

      const ref = cache.entity("User", "1");
      expect(cacheField(cache, ref, "name").sig()).toBe("Bob");
    });

    test("executes mutation operation descriptors", async () => {
      const cache = createNormalizedCache();
      const fetcher = vi.fn<Fetcher>(async () => ({
        renameUser: { __typename: "User", id: "1", name: "Alice" },
      }));
      const mutate = createMutation(
        {
          operationName: "renameUser",
          query:
            "mutation renameUser($id: ID!, $name: String!) { renameUser(id: $id, name: $name) { id __typename name } }",
          variables: (input: { id: string; name: string }) => ({
            id: input.id,
            name: input.name,
          }),
        },
        { cache, fetcher },
      );

      await mutate({ id: "1", name: "Alice" });

      expect(fetcher).toHaveBeenCalledWith(
        expect.objectContaining({
          operationName: "renameUser",
          variables: { id: "1", name: "Alice" },
        }),
      );
      expect(cacheField(cache, cache.entity("User", "1"), "name").sig()).toBe("Alice");
    });

    test("accepts mutation options object", async () => {
      const cache = createNormalizedCache();
      const fetcher = vi.fn<Fetcher>(async () => ({
        renameUser: { __typename: "User", id: "1", name: "Alice" },
      }));
      const mutate = createMutation(
        {
          operationName: "renameUser",
          query: "mutation renameUser($id: ID!) { renameUser(id: $id) { id __typename name } }",
          variables: (input: { id: string }) => ({ id: input.id }),
        },
        { cache, fetcher },
      );

      await mutate({ id: "1" });

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(cacheField(cache, cache.entity("User", "1"), "name").sig()).toBe("Alice");
    });

    test("runs optimistic update callback", async () => {
      const cache = createNormalizedCache();
      const mutate = createMutation(
        async (input: { name: string }) => ({
          renameUser: { __typename: "User", id: "1", name: input.name },
        }),
        { cache },
      );

      let optimisticRan = false;
      await mutate({
        name: "Alice",
        optimistic(c) {
          optimisticRan = true;
          cacheField(c, c.entity("User", "1"), "name").sig("Alice");
        },
        invalidates: [
          {
            kind: "entity",
            ref: { type: "User", id: "1" },
            paths: [[{ field: "name" }]],
          },
        ],
      });

      expect(optimisticRan).toBe(true);
    });

    test("applies invalidates after successful mutation", async () => {
      const cache = createNormalizedCache();
      const mutate = createMutation(
        async (input: { name: string }) => ({
          renameUser: { __typename: "User", id: "1", name: input.name },
        }),
        { cache },
      );

      await mutate({
        name: "Alice",
        invalidates: [
          {
            kind: "entity",
            ref: { type: "User", id: "1" },
            paths: [[{ field: "name" }]],
          },
        ],
      });

      const field = cacheField(cache, cache.entity("User", "1"), "name");
      expect(field.sig()).toBe("Alice");
      expect(field.expires).toBe(0);
    });

    test("accepts selector invalidation targets", async () => {
      const cache = createNormalizedCache();
      const refs = cacheSlot<readonly { type: string; id: string }[]>(
        cache,
        'Query.search({"text":"a"}).refs',
      );
      refs.sig([{ type: "User", id: "1" }]);
      const mutate = createMutation(async () => ({ ok: true }), { cache });

      await mutate({
        invalidates: [
          {
            kind: "selection",
            path: {
              root: "Query",
              steps: [{ field: "search", args: { text: "a" } }, { field: "refs" }],
            },
          },
        ],
      });

      expect(refs.expires).toBeLessThan(Date.now());
    });

    test("rolls back optimistic selector invalidations with descriptor metadata", async () => {
      const cache = createNormalizedCache();
      cacheField(cache, cache.entity("User", "1"), "name").sig("Original");
      const fetcher = vi.fn<Fetcher>(async () => {
        throw new Error("server rejected");
      });
      const mutate = createMutation(
        {
          operationName: "renameUser",
          query: "mutation renameUser($id: ID!) { renameUser(id: $id) { id __typename name } }",
          metadata: {
            roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
            types: { User: { name: { returnsEntity: false } } },
          },
          variables: (input: { id: string }) => ({ id: input.id }),
        },
        { cache, fetcher },
      );

      await expect(
        mutate({
          id: "1",
          optimistic(c) {
            cacheField(c, c.entity("User", "1"), "name").sig("Optimistic");
          },
          invalidates: [
            {
              kind: "selection",
              path: {
                root: "Query",
                steps: [{ field: "user", args: { id: "1" } }, { field: "name" }],
              },
            },
          ],
        }),
      ).rejects.toThrow("server rejected");

      expect(cacheField(cache, cache.entity("User", "1"), "name").sig()).toBe("Original");
    });

    test("rolls back optimistic writes on error", async () => {
      const cache = createNormalizedCache();
      // Pre-populate cache
      cache.normalize({
        renameUser: { __typename: "User", id: "1", name: "original" },
      });

      const mutate = createMutation(
        async () => {
          throw new Error("server rejected");
        },
        { cache },
      );

      await expect(
        mutate({
          name: "Alice",
          optimistic(c) {
            cacheField(c, c.entity("User", "1"), "name").sig("bad-write");
          },
          invalidates: [
            {
              kind: "entity",
              ref: { type: "User", id: "1" },
              paths: [[{ field: "name" }]],
            },
          ],
        }),
      ).rejects.toThrow("server rejected");

      const ref = cache.entity("User", "1");
      expect(cacheField(cache, ref, "name").sig()).toBe("original");
      expect(cacheField(cache, ref, "name").expires).toBe(0);
    });
  });
});

describe("lifecycle", () => {
  test("dispose unregisters reader and stops signal watches", () => {
    const cache = createNormalizedCache();
    const sig = createSignal("hello");

    createRoot((dispose) => {
      const state = createQuery({ cache });
      const unmountSpy = vi.spyOn(state.session, "unmount");
      expect(state.read(sig)).toBe("hello");

      dispose();

      expect(unmountSpy).toHaveBeenCalledTimes(1);
    });
  });

  test("dispose allows re-creation of a new reader scope", () => {
    const cache = createNormalizedCache();

    createRoot((dispose) => {
      const state = createQuery({ cache });
      state.demand("Query", [{ field: "viewer" }]);
      dispose();

      const state2 = createQuery({ cache });
      const unmountSpy2 = vi.spyOn(state2.session, "unmount");
      state2.demand("Query", [{ field: "user" }]);
      expect(unmountSpy2).not.toHaveBeenCalled();
      unmountSpy2.mockRestore();
    });
  });

  test("dispose cleans up signal subscription", () => {
    const cache = createNormalizedCache();
    const sig = createSignal("first");

    createRoot((dispose) => {
      const state = createQuery({ cache });
      expect(state.read(sig)).toBe("first");

      dispose();

      expect(() => sig("second")).not.toThrow();
    });
  });
});

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

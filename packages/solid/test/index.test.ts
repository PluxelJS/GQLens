import { describe, expect, test, vi, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createQuery, createLiveQuery, createMutation } from "@gqlens/solid";
import {
  createNormalizedCache,
  createSignal,
  type Fetcher,
  type LiveSubscriber,
} from "@gqlens/core";

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
      await new Promise((resolve) => setTimeout(resolve, 0));

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
        liveSubscriber,
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
      expect(cache.field(cache.entity("User", "1"), "name").sig()).toBe("Alice");
    });
  });

  describe("createMutation", () => {
    test("returns a callable async function", async () => {
      const cache = createNormalizedCache();
      const mutate = createMutation(
        async (input: { name: string }) => ({ success: true, ...input }),
        cache,
      );

      expect(typeof mutate).toBe("function");
    });

    test("normalizes server response into cache", async () => {
      const cache = createNormalizedCache();
      const mutate = createMutation(
        async (input: { name: string }) => ({
          renameUser: { __typename: "User", id: "1", name: input.name },
        }),
        cache,
      );

      await mutate({ name: "Bob" });

      const ref = cache.entity("User", "1");
      expect(cache.field(ref, "name").sig()).toBe("Bob");
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
        cache,
        fetcher,
      );

      await mutate({ id: "1", name: "Alice" });

      expect(fetcher).toHaveBeenCalledWith(
        expect.objectContaining({
          operationName: "renameUser",
          variables: { id: "1", name: "Alice" },
        }),
      );
      expect(cache.field(cache.entity("User", "1"), "name").sig()).toBe("Alice");
    });

    test("runs optimistic update callback", async () => {
      const cache = createNormalizedCache();
      const mutate = createMutation(
        async (input: { name: string }) => ({
          renameUser: { __typename: "User", id: "1", name: input.name },
        }),
        cache,
      );

      let optimisticRan = false;
      await mutate({
        name: "Alice",
        optimistic(c) {
          optimisticRan = true;
          c.field(c.entity("User", "1"), "name").sig("Alice");
        },
        invalidates: [{ type: "User", id: "1", keys: ["name"] }],
      });

      expect(optimisticRan).toBe(true);
    });

    test("applies invalidates after successful mutation", async () => {
      const cache = createNormalizedCache();
      const mutate = createMutation(
        async (input: { name: string }) => ({
          renameUser: { __typename: "User", id: "1", name: input.name },
        }),
        cache,
      );

      await mutate({
        name: "Alice",
        invalidates: [{ type: "User", id: "1", keys: ["name"] }],
      });

      const field = cache.field(cache.entity("User", "1"), "name");
      expect(field.sig()).toBe("Alice");
      expect(field.expires).toBe(0);
    });

    test("accepts selector invalidation targets", async () => {
      const cache = createNormalizedCache();
      const refs = cache.slot<readonly { type: string; id: string }[]>(
        'Query.search({"text":"a"}).refs',
      );
      refs.sig([{ type: "User", id: "1" }]);
      const mutate = createMutation(async () => ({ ok: true }), cache);

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

    test("rolls back optimistic writes on error", async () => {
      const cache = createNormalizedCache();
      // Pre-populate cache
      cache.normalize({
        renameUser: { __typename: "User", id: "1", name: "original" },
      });

      const mutate = createMutation(async () => {
        throw new Error("server rejected");
      }, cache);

      await expect(
        mutate({
          name: "Alice",
          optimistic(c) {
            c.field(c.entity("User", "1"), "name").sig("bad-write");
          },
          invalidates: [{ type: "User", id: "1", keys: ["name"] }],
        }),
      ).rejects.toThrow("server rejected");

      const ref = cache.entity("User", "1");
      expect(cache.field(ref, "name").sig()).toBe("original");
      expect(cache.field(ref, "name").expires).toBe(0);
    });
  });
});

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

import { describe, expect, test, vi, afterEach } from "vitest";
import { createElement, StrictMode } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import {
  GQLensProvider,
  useQuery,
  useLiveQuery,
  usePreparedQuery,
  useMutation,
  type SessionState,
} from "@gqlens/react";
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

function wrapper(overrides: Partial<Parameters<typeof GQLensProvider>[0]["config"]> = {}) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(GQLensProvider, {
      config: { endpoint: "/graphql", ...overrides },
      children,
    });
  };
}

describe("React adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GQLensProvider + useQuery", () => {
    test("returns loading and error state", () => {
      const { result } = renderHook(() => useQuery(), { wrapper: wrapper() });
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.session).toBeDefined();
      expect(result.current.cache).toBeDefined();
    });

    test("throws without provider", () => {
      expect(() => renderHook(() => useQuery())).toThrow("GQLensProvider");
    });

    test("accepts custom config", () => {
      const { result } = renderHook(() => useQuery({ policy: "network-only", ttl: 5000 }), {
        wrapper: wrapper(),
      });
      expect(result.current.session).toBeDefined();
      expect(result.current.loading).toBe(false);
    });

    test("accepts grouped provider defaults", () => {
      const { result } = renderHook(
        () =>
          [
            useQuery({ scope: "shared" }),
            useQuery({ scope: "shared", policy: "cache-first", ttl: 5000 }),
            useQuery({ scope: "shared", policy: "network-only", ttl: 5000 }),
          ] as const,
        {
          wrapper: wrapper({ query: { policy: "cache-first", ttl: 5000 } }),
        },
      );

      expect(result.current[0].session).toBe(result.current[1].session);
      expect(result.current[0].session).not.toBe(result.current[2].session);
    });

    test("keeps local query sessions isolated by default", () => {
      const { result } = renderHook(() => [useQuery(), useQuery()] as const, {
        wrapper: wrapper(),
      });

      expect(result.current[0].cache).toBe(result.current[1].cache);
      expect(result.current[0].session).not.toBe(result.current[1].session);
    });

    test("shares query sessions only through explicit scope", () => {
      const { result } = renderHook(
        () => [useQuery({ scope: "shared" }), useQuery({ scope: "shared" })] as const,
        {
          wrapper: wrapper(),
        },
      );

      expect(result.current[0].cache).toBe(result.current[1].cache);
      expect(result.current[0].session).toBe(result.current[1].session);
    });

    test("keeps one cache even when query policies need distinct sessions", () => {
      const { result } = renderHook(
        () => [useQuery({ policy: "cache-first" }), useQuery({ policy: "network-only" })] as const,
        { wrapper: wrapper() },
      );

      expect(result.current[0].cache).toBe(result.current[1].cache);
      expect(result.current[0].session).not.toBe(result.current[1].session);
    });

    test("runs prepared selections with bound variables", async () => {
      const fetcher = vi
        .fn<Fetcher>()
        .mockResolvedValueOnce({
          user: { __typename: "User", id: "1", name: "Alice" },
        })
        .mockResolvedValueOnce({
          user: { __typename: "User", id: "2", name: "Bob" },
        });
      const metadata = {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      } as const;
      const { rerender } = renderHook(
        ({ id }: { readonly id: string }) => {
          const state = usePreparedQuery(
            userNameSelection,
            { id },
            { policy: "network-only", metadata },
          );
          return state.loading;
        },
        { initialProps: { id: "1" }, wrapper: wrapper({ fetcher }) },
      );

      await waitFor(() => {
        expect(fetcher).toHaveBeenCalledTimes(1);
      });
      rerender({ id: "2" });
      await waitFor(() => {
        expect(fetcher).toHaveBeenCalledTimes(2);
      });

      expect(fetcher).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ variables: { v0: "1" } }),
      );
      expect(fetcher).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ variables: { v0: "2" } }),
      );
    });
  });

  describe("useLiveQuery", () => {
    test("returns session with live transport", () => {
      const { result } = renderHook(() => useLiveQuery(), { wrapper: wrapper() });
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.session).toBeDefined();
      expect(result.current.cache).toBeDefined();
    });

    test("accepts an external live subscriber", async () => {
      const listeners: Array<(data: unknown) => void> = [];
      const liveSubscriber = vi.fn<LiveSubscriber>((_, onData) => {
        listeners.push(onData);
        return () => undefined;
      });
      const { result } = renderHook(
        () => {
          const state = useLiveQuery({
            metadata: {
              roots: { viewer: { returnsEntity: true, graphQLType: "User" } },
              types: { User: { name: { returnsEntity: false } } },
            },
          });
          state.demand("Query", [{ field: "viewer" }, { field: "name" }]);
          return state;
        },
        { wrapper: wrapper({ endpoint: undefined, live: { subscriber: liveSubscriber } }) },
      );

      await waitFor(() => {
        expect(liveSubscriber).toHaveBeenCalledTimes(1);
      });

      act(() => {
        listeners[0]?.({ viewer: { __typename: "User", id: "1", name: "Alice" } });
      });

      await waitFor(() => {
        expect(cacheField(result.current.cache, { type: "User", id: "1" }, "name").sig()).toBe(
          "Alice",
        );
      });
    });
  });

  describe("reader scope", () => {
    test("reads alien-signals through state", () => {
      const { result } = renderHook(() => useQuery(), { wrapper: wrapper() });
      const sig = createSignal("hello");
      expect(result.current.read(sig)).toBe("hello");
    });

    test("records demanded selections through state", () => {
      const { result } = renderHook(() => useQuery(), { wrapper: wrapper() });
      expect(() => result.current.demand("Query", [{ field: "user" }])).not.toThrow();
    });

    test("rerenders when a read alien-signal changes", async () => {
      const sig = createSignal("first");
      const { result } = renderHook(() => useQuery().read(sig), {
        wrapper: wrapper(),
      });

      expect(result.current).toBe("first");

      act(() => {
        sig("second");
      });

      await waitFor(() => {
        expect(result.current).toBe("second");
      });
    });

    test("rerenders when session loading changes", async () => {
      const resolvers: Array<(value: Record<string, unknown>) => void> = [];
      const fetcher = vi.fn<Fetcher>(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          }),
      );
      const { result } = renderHook(
        () => {
          const state = useQuery({ policy: "network-only" });
          state.demand("Query", [{ field: "viewer" }, { field: "name" }]);
          return state.loading;
        },
        { wrapper: wrapper({ fetcher }) },
      );

      await waitFor(() => {
        expect(result.current).toBe(true);
      });

      act(() => {
        resolvers[0]?.({ viewer: { __typename: "User", id: "1", name: "Alice" } });
      });

      await waitFor(() => {
        expect(result.current).toBe(false);
      });
    });

    test("commits render demands and schedules a query operation", async () => {
      const fetcher = vi.fn<Fetcher>(async () => ({
        viewer: { __typename: "User", id: "1", name: "Alice" },
      }));
      renderHook(
        () => {
          const state = useQuery({ policy: "network-only" });
          state.demand("Query", [{ field: "viewer" }, { field: "name" }]);
          return state;
        },
        { wrapper: wrapper({ fetcher }) },
      );

      await waitFor(() => {
        expect(fetcher).toHaveBeenCalledTimes(1);
      });
      expect(fetcher).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining("viewer"),
        }),
      );
    });

    test("does not reschedule an unchanged selection after render-only updates", async () => {
      const fetcher = vi.fn<Fetcher>(async () => ({}));
      renderHook(
        () => {
          const state = useQuery({ policy: "cache-and-network" });
          state.demand("Query", [{ field: "viewer" }, { field: "name" }]);
          return state.loading;
        },
        { wrapper: wrapper({ fetcher }) },
      );

      await waitFor(() => {
        expect(fetcher).toHaveBeenCalledTimes(1);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test("schedules again when data reveals a dependent selection", async () => {
      const cache = createNormalizedCache();
      const metadata = {
        roots: {
          users: { returnsEntity: true, returnsList: true, graphQLType: "User" },
          user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } },
        },
        types: {
          User: {
            name: { returnsEntity: false },
          },
        },
      } as const;
      const fetcher = vi
        .fn<Fetcher>()
        .mockResolvedValueOnce({
          users: [{ __typename: "User", id: "1" }],
        })
        .mockResolvedValueOnce({
          users: [{ __typename: "User", id: "1" }],
          user: { __typename: "User", id: "1", name: "Alice" },
        });

      const { result } = renderHook(
        () => {
          const state = useQuery({ policy: "cache-first", metadata });
          state.demand("Query", [{ field: "users" }, { field: "ids" }]);
          demandFirstUserName(state);
          return state.loading;
        },
        { wrapper: wrapper({ cache, fetcher }) },
      );

      await waitFor(() => {
        expect(fetcher).toHaveBeenCalledTimes(2);
      });
      expect(result.current).toBe(false);
      expect(cacheField<string>(cache, cache.entity("User", "1"), "name").sig()).toBe("Alice");
    });
  });

  describe("useMutation", () => {
    test("executes mutation operation descriptors through provider fetcher", async () => {
      const fetcher = vi.fn<Fetcher>(async () => ({
        renameUser: { __typename: "User", id: "1", name: "Alice" },
      }));
      const { result } = renderHook(
        () =>
          useMutation({
            operationName: "renameUser",
            query:
              "mutation renameUser($id: ID!, $name: String!) { renameUser(id: $id, name: $name) { id __typename name } }",
            variables: (input: { id: string; name: string }) => ({
              id: input.id,
              name: input.name,
            }),
          }),
        { wrapper: wrapper({ fetcher }) },
      );

      await expect(result.current({ id: "1", name: "Alice" })).resolves.toStrictEqual({
        __typename: "User",
        id: "1",
        name: "Alice",
      });
      expect(fetcher).toHaveBeenCalledWith(
        expect.objectContaining({
          operationName: "renameUser",
          variables: { id: "1", name: "Alice" },
        }),
      );
    });

    test("normalizes mutation results into the provider cache", async () => {
      const fetcher = vi.fn<Fetcher>(async () => ({
        renameUser: { __typename: "User", id: "1", name: "Alice" },
      }));
      const { result } = renderHook(
        () => {
          const state = useQuery();
          const rename = useMutation({
            operationName: "renameUser",
            query:
              "mutation renameUser($id: ID!, $name: String!) { renameUser(id: $id, name: $name) { id __typename name } }",
            variables: (input: { id: string; name: string }) => ({
              id: input.id,
              name: input.name,
            }),
          });
          return { state, rename };
        },
        { wrapper: wrapper({ fetcher }) },
      );

      await result.current.rename({
        id: "1",
        name: "Alice",
        invalidates: [
          {
            kind: "entity",
            ref: { type: "User", id: "1" },
            paths: [[{ field: "name" }]],
          },
        ],
      });

      expect(cacheField(result.current.state.cache, { type: "User", id: "1" }, "name").sig()).toBe(
        "Alice",
      );
    });

    test("applies invalidates and refetches active provider sessions after success", async () => {
      const fetcher = vi
        .fn<Fetcher>()
        .mockResolvedValueOnce({
          user: {
            __typename: "User",
            id: "1",
            name: "Alice",
          },
        })
        .mockResolvedValueOnce({ renameUser: true })
        .mockResolvedValueOnce({
          user: {
            __typename: "User",
            id: "1",
            name: "Fresh Alice",
          },
        });
      const { result } = renderHook(
        () => {
          const state = useQuery({
            policy: "cache-and-network",
            metadata: {
              roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
              types: { User: { name: { returnsEntity: false } } },
            },
          });
          state.demand("Query", [{ field: "user", args: { id: "1" } }, { field: "name" }]);
          const rename = useMutation({
            operationName: "renameUser",
            query: "mutation renameUser($id: ID!) { renameUser(id: $id) }",
            variables: (input: { id: string }) => ({ id: input.id }),
          });
          return { state, rename };
        },
        { wrapper: wrapper({ fetcher }) },
      );

      await waitFor(() => {
        expect(
          cacheField(result.current.state.cache, { type: "User", id: "1" }, "name").sig(),
        ).toBe("Alice");
      });

      await result.current.rename({
        id: "1",
        invalidates: [
          {
            kind: "entity",
            ref: { type: "User", id: "1" },
            paths: [[{ field: "name" }]],
          },
        ],
      });

      await waitFor(() => {
        expect(
          cacheField(result.current.state.cache, { type: "User", id: "1" }, "name").sig(),
        ).toBe("Fresh Alice");
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(fetcher.mock.calls.map(([op]) => op.operationName)).toStrictEqual([
        "GQLens",
        "renameUser",
        "GQLens",
      ]);
    });

    test("accepts selector invalidation targets in mutation options", async () => {
      const fetcher = vi
        .fn<Fetcher>()
        .mockResolvedValueOnce({
          user: { __typename: "User", id: "1", name: "Alice" },
        })
        .mockResolvedValueOnce({ renameUser: true })
        .mockResolvedValueOnce({
          user: { __typename: "User", id: "1", name: "Fresh Alice" },
        });
      const { result } = renderHook(
        () => {
          const state = useQuery({
            policy: "cache-and-network",
            metadata: {
              roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
              types: { User: { name: { returnsEntity: false } } },
            },
          });
          state.demand("Query", [{ field: "user", args: { id: "1" } }, { field: "name" }]);
          const rename = useMutation({
            operationName: "renameUser",
            query: "mutation renameUser($id: ID!) { renameUser(id: $id) }",
            variables: (input: { id: string }) => ({ id: input.id }),
          });
          return { state, rename };
        },
        { wrapper: wrapper({ fetcher }) },
      );

      await waitFor(() => {
        expect(
          cacheField(result.current.state.cache, { type: "User", id: "1" }, "name").sig(),
        ).toBe("Alice");
      });

      await result.current.rename({
        id: "1",
        invalidates: [
          {
            kind: "selection",
            path: {
              root: "Query",
              steps: [{ field: "user", args: { id: "1" } }, { field: "name" }],
            },
          },
        ],
      });

      await waitFor(() => {
        expect(
          cacheField(result.current.state.cache, { type: "User", id: "1" }, "name").sig(),
        ).toBe("Fresh Alice");
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
    });

    test("rolls back optimistic selector invalidations with descriptor metadata", async () => {
      const cache = createNormalizedCache();
      cacheField(cache, cache.entity("User", "1"), "name").sig("Original");
      const fetcher = vi.fn<Fetcher>(async () => {
        throw new Error("server rejected");
      });
      const metadata = {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      } as const;
      const { result } = renderHook(
        () =>
          useMutation({
            operationName: "renameUser",
            query: "mutation renameUser($id: ID!) { renameUser(id: $id) { id __typename name } }",
            metadata,
            variables: (input: { id: string }) => ({ id: input.id }),
          }),
        { wrapper: wrapper({ cache, fetcher }) },
      );

      await expect(
        result.current({
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
  });

  describe("lifecycle", () => {
    test("unmounts reader on component cleanup", () => {
      const cache = createNormalizedCache();
      const { result, unmount } = renderHook(() => useQuery(), {
        wrapper: wrapper({ cache }),
      });
      const session = result.current.session;
      const unmountSpy = vi.spyOn(session, "unmount");
      result.current.demand("Query", [{ field: "viewer" }]);

      unmount();

      expect(unmountSpy).toHaveBeenCalledTimes(1);
    });

    test("strict mode remounts reader correctly", async () => {
      const cache = createNormalizedCache();
      const fetcher = vi.fn<Fetcher>(async () => ({
        viewer: { __typename: "User", id: "1", name: "Alice" },
      }));

      function StrictWrapper({ children }: { children: React.ReactNode }) {
        return createElement(StrictMode, null, wrapper({ cache, fetcher })({ children }));
      }

      renderHook(
        () => {
          const state = useQuery({
            policy: "network-only",
            metadata: {
              roots: { viewer: { returnsEntity: true, graphQLType: "User" } },
              types: { User: { name: { returnsEntity: false } } },
            },
          });
          state.demand("Query", [{ field: "viewer" }, { field: "name" }]);
          return state;
        },
        { wrapper: StrictWrapper },
      );

      await waitFor(() => {
        expect(cacheField(cache, cache.entity("User", "1"), "name").sig()).toBe("Alice");
      });
    });

    test("releases unmounted local sessions from provider invalidation", async () => {
      const metadata = {
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      } as const;
      const fetcher = vi
        .fn<Fetcher>()
        .mockResolvedValueOnce({
          user: { __typename: "User", id: "1", name: "Alice" },
        })
        .mockResolvedValueOnce({ renameUser: true })
        .mockResolvedValue({
          user: { __typename: "User", id: "1", name: "Fresh Alice" },
        });
      let rename = missingMutationChild;

      function QueryChild() {
        const state = useQuery({ policy: "cache-and-network", metadata });
        state.demand("Query", [{ field: "user", args: { id: "1" } }, { field: "name" }]);
        return null;
      }

      function MutationChild() {
        const mutate = useMutation({
          operationName: "renameUser",
          query: "mutation renameUser($id: ID!) { renameUser(id: $id) }",
          variables: (input: { id: string }) => ({ id: input.id }),
        });
        rename = () =>
          mutate({
            id: "1",
            invalidates: [
              {
                kind: "entity",
                ref: { type: "User", id: "1" },
                paths: [[{ field: "name" }]],
              },
            ],
          });
        return null;
      }

      const view = render(
        createElement(GQLensProvider, {
          config: { fetcher },
          children: [
            createElement(QueryChild, { key: "query" }),
            createElement(MutationChild, { key: "mutation" }),
          ],
        }),
      );
      await waitFor(() => {
        expect(fetcher).toHaveBeenCalledTimes(1);
      });

      view.rerender(
        createElement(GQLensProvider, {
          config: { fetcher },
          children: createElement(MutationChild, { key: "mutation" }),
        }),
      );
      await act(async () => {
        await rename();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls.map(([op]) => op.operationName)).toStrictEqual([
        "GQLens",
        "renameUser",
      ]);
    });

    test("cleans up signal subscriptions on unmount", () => {
      const cache = createNormalizedCache();
      const sig = createSignal("first");
      const { result, unmount } = renderHook(() => useQuery().read(sig), {
        wrapper: wrapper({ cache }),
      });

      expect(result.current).toBe("first");

      unmount();

      expect(() => act(() => sig("second"))).not.toThrow();
    });
  });
});

function demandFirstUserName(state: SessionState): void {
  const ids = state.read(cacheSlot<readonly string[]>(state.cache, "Query.users.ids").sig);
  const id = ids?.[0];
  if (id === undefined) {
    return;
  }
  state.demand("Query", [{ field: "user", args: { id } }, { field: "name" }]);
}

async function missingMutationChild(): Promise<unknown> {
  throw new Error("mutation child was not mounted");
}

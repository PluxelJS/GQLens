import { describe, expect, test, vi, afterEach } from "vitest";
import { createElement } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { GQLensProvider, useQuery, useLiveQuery, useMutation } from "@gqlens/react";
import { createSignal, type Fetcher } from "@gqlens/core";

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

    test("shares cache and session within a provider for matching config", () => {
      const { result } = renderHook(() => [useQuery(), useQuery()] as const, {
        wrapper: wrapper(),
      });

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
  });

  describe("useLiveQuery", () => {
    test("returns session with live transport", () => {
      const { result } = renderHook(() => useLiveQuery(), { wrapper: wrapper() });
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.session).toBeDefined();
      expect(result.current.cache).toBeDefined();
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

      await result.current.rename({ id: "1", name: "Alice" });

      expect(result.current.state.cache.field({ type: "User", id: "1" }, "name").sig()).toBe(
        "Alice",
      );
    });
  });
});

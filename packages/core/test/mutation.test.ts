import { describe, expect, test, vi } from "vitest";
import { createMutationRunner, createGraphDataStore, type Fetcher } from "@gqlens/core";
import {
  cacheField,
  cacheSlot,
  peekCacheField,
  peekCacheSlot,
  schemaContract,
} from "./cache-helpers";

// ─── Mutation Runner ───────────────────────────────────────────────────────

describe("Mutation runner", () => {
  test("executes operation descriptors, unwraps GraphQL envelopes, and normalizes results", async () => {
    const cache = createGraphDataStore();
    const fetcher = vi.fn<Fetcher>(async () => ({
      data: { renameUser: { __typename: "User", id: "1", name: "Alice" } },
    }));
    const mutate = createMutationRunner({
      store: cache,
      fetcher,
      definition: {
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
    expect(cacheField(cache, cache.entity("User", "1"), "name").sig()).toBe("Alice");
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({
        operationName: "renameUser",
        variables: { id: "1" },
      }),
    );
  });

  test("rolls back optimistic entity writes on failure", async () => {
    const cache = createGraphDataStore();
    const name = cacheField(cache, cache.entity("User", "1"), "name");
    const avatar = cacheField(cache, cache.entity("User", "1"), "avatar");
    name.sig("Original");
    name.expires = 123;
    avatar.sig("original.png");
    const mutate = createMutationRunner({
      store: cache,
      fetcher: async () => ({}),
      definition: async () => {
        throw new Error("nope");
      },
    });

    await expect(
      mutate(
        {},
        {
          optimistic(c) {
            const field = cacheField(c, c.entity("User", "1"), "name");
            field.sig("Optimistic");
            field.expires = 999;
            cacheField(c, c.entity("User", "1"), "avatar").sig("optimistic.png");
          },
          invalidates: [
            {
              kind: "entity",
              ref: { type: "User", id: "1" },
              paths: [[{ field: "name" }], [{ field: "avatar" }]],
            },
          ],
        },
      ),
    ).rejects.toThrow("nope");

    expect(cacheField(cache, cache.entity("User", "1"), "name").sig()).toBe("Original");
    expect(cacheField(cache, cache.entity("User", "1"), "name").expires).toBe(123);
    expect(cacheField(cache, cache.entity("User", "1"), "avatar").sig()).toBe("original.png");
  });

  test("rolls back optimistic writes without invalidation hints", async () => {
    const cache = createGraphDataStore();
    cacheField(cache, cache.entity("User", "1"), "name").sig("Original");
    const mutate = createMutationRunner({
      store: cache,
      fetcher: async () => ({}),
      definition: async () => {
        throw new Error("nope");
      },
    });

    await expect(
      mutate(
        {},
        {
          optimistic(c) {
            cacheField(c, c.entity("User", "1"), "name").sig("Optimistic");
            cacheSlot(c, "User:1.posts.ids").sig(["10"]);
          },
        },
      ),
    ).rejects.toThrow("nope");

    expect(cacheField(cache, cache.entity("User", "1"), "name").sig()).toBe("Original");
    expect(peekCacheSlot(cache, "User:1.posts.ids")).toBeUndefined();
  });

  test("rolls back optimistic normalize writes on failure", async () => {
    const cache = createGraphDataStore();
    cache.writeGraphQLResult({ user: { __typename: "User", id: "1", name: "Original" } });
    const mutate = createMutationRunner({
      store: cache,
      fetcher: async () => ({}),
      definition: async () => {
        throw new Error("nope");
      },
    });

    await expect(
      mutate(
        {},
        {
          optimistic(c) {
            c.writeGraphQLResult({
              user: { __typename: "User", id: "1", name: "Optimistic", avatar: "new.png" },
            });
          },
        },
      ),
    ).rejects.toThrow("nope");

    expect(cacheField(cache, cache.entity("User", "1"), "name").sig()).toBe("Original");
    expect(peekCacheField(cache, cache.entity("User", "1"), "avatar")).toBeUndefined();
  });

  test("rolls back optimistic writes addressed by selector invalidation targets", async () => {
    const cache = createGraphDataStore();
    cacheField(cache, cache.entity("User", "1"), "name").sig("Original");
    const mutate = createMutationRunner({
      store: cache,
      fetcher: async () => ({}),
      definition: async () => {
        throw new Error("nope");
      },
      schema: schemaContract({
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      }),
    });

    await expect(
      mutate(
        {},
        {
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
        },
      ),
    ).rejects.toThrow("nope");

    expect(cacheField(cache, cache.entity("User", "1"), "name").sig()).toBe("Original");
  });

  test("uses operation descriptor schema for selector rollback", async () => {
    const cache = createGraphDataStore();
    cacheField(cache, cache.entity("User", "1"), "name").sig("Original");
    const mutate = createMutationRunner({
      store: cache,
      fetcher: async () => {
        throw new Error("nope");
      },
      definition: {
        operationName: "renameUser",
        query: "mutation renameUser($id: ID!) { renameUser(id: $id) { id __typename name } }",
        schema: schemaContract({
          roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
          types: { User: { name: { returnsEntity: false } } },
        }),
        variables: (input: { id: string }) => ({ id: input.id }),
      },
    });

    await expect(
      mutate(
        { id: "1" },
        {
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
        },
      ),
    ).rejects.toThrow("nope");

    expect(cacheField(cache, cache.entity("User", "1"), "name").sig()).toBe("Original");
  });

  test("normalizes embedded value object leaves from entity mutation responses", async () => {
    const cache = createGraphDataStore();
    const mutate = createMutationRunner({
      store: cache,
      fetcher: async () => ({
        data: {
          renameUser: {
            __typename: "User",
            id: "1",
            name: "Alice",
            status: { online: true },
          },
        },
      }),
      definition: {
        operationName: "renameUser",
        query:
          "mutation renameUser($id: ID!) { renameUser(id: $id) { id __typename name status { online } } }",
        variables: (input: { id: string }) => ({ id: input.id }),
      },
      schema: schemaContract({
        mutation: {
          renameUser: {
            returnsEntity: true,
            graphQLType: "User",
            objectKind: "entity",
          },
        },
        types: {
          User: {
            name: { returnsEntity: false },
            status: {
              returnsEntity: false,
              graphQLType: "UserStatus",
              objectKind: "value",
            },
          },
          UserStatus: {
            online: { returnsEntity: false },
          },
        },
      }),
    });

    await mutate({ id: "1" });

    expect(cacheField(cache, cache.entity("User", "1"), "status.online").sig()).toBe(true);
  });
});

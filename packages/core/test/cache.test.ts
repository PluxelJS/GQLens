import { describe, expect, test } from "vitest";
import { createNormalizedCache } from "@gqlens/core";
import {
  cacheField,
  cacheSlot,
  isCacheFieldFresh,
  isCacheSlotFresh,
  peekCacheField,
  peekCacheSlot,
} from "./cache-helpers";

describe("NormalizedCache", () => {
  test("stores and retrieves field values via signals", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");
    const nameSignal = cacheField<string>(cache, ref, "name");

    nameSignal.sig("Alice");
    expect(nameSignal.sig()).toBe("Alice");
  });

  test("reads and writes through canonical cache addresses", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");
    const address = {
      owner: { kind: "entity", ref },
      path: [{ field: "name" }],
    } as const;

    cache.write(address, "Alice");

    expect(cache.read(address)).toBe("Alice");
    expect(cacheField<string>(cache, ref, "name").sig()).toBe("Alice");
  });

  test("invalidates address families through canonical cache targets", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");
    const address = {
      owner: { kind: "entity", ref },
      path: [{ field: "posts" }],
    } as const;
    cache.write({ ...address, facet: "ids" }, ["10"]);
    cache.write({ ...address, facet: "refs" }, [{ type: "Post", id: "10" }]);

    cache.invalidate({ kind: "address", address, family: true });

    expect(cache.entry({ ...address, facet: "ids" }).expires).toBeLessThan(Date.now());
    expect(cache.entry({ ...address, facet: "refs" }).expires).toBeLessThan(Date.now());
  });

  test("reads and writes entity relation links through canonical cache addresses", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");
    const address = {
      owner: { kind: "entity", ref },
      path: [{ field: "bestFriend" }],
      facet: "link",
    } as const;

    cache.write(address, { type: "User", id: "2" });

    expect(cache.read(address)).toStrictEqual({ type: "User", id: "2" });
    expect(cacheSlot(cache, "User:1.bestFriend").sig()).toStrictEqual({ type: "User", id: "2" });
  });

  test("transactions roll back tracked writes", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");
    cacheField(cache, ref, "name").sig("Original");

    const transaction = cache.transaction((draft) => {
      cacheField(draft, ref, "name").sig("Optimistic");
      cacheSlot(draft, "User:1.posts.ids").sig(["10"]);
    });

    expect(cacheField(cache, ref, "name").sig()).toBe("Optimistic");
    expect(cacheSlot(cache, "User:1.posts.ids").sig()).toStrictEqual(["10"]);

    transaction.rollback();

    expect(cacheField(cache, ref, "name").sig()).toBe("Original");
    expect(peekCacheSlot(cache, "User:1.posts.ids")).toBeUndefined();
  });

  test("keeps entity refs stable within a cache without sharing refs across caches", () => {
    const first = createNormalizedCache();
    const second = createNormalizedCache();

    expect(first.entity("User", "1")).toBe(first.entity("User", "1"));
    expect(first.entity("User", "1")).not.toBe(second.entity("User", "1"));
  });

  test("reads undefined for unset fields", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "99");
    expect(cacheField(cache, ref, "name").sig()).toBeUndefined();
  });

  test("peeks without creating missing entries", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "99");

    expect(peekCacheField(cache, ref, "name")).toBeUndefined();
    expect(peekCacheSlot(cache, "Query.missing")).toBeUndefined();
    expect(peekCacheField(cache, ref, "name")).toBeUndefined();
    expect(peekCacheSlot(cache, "Query.missing")).toBeUndefined();
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
    expect(cacheField<string>(cache, ref, "name").sig()).toBe("Alice");
    expect(cacheField<string>(cache, ref, "avatar").sig()).toBe("/avatar.png");
    expect(cacheField<string>(cache, ref, "__typename").sig()).toBe("User");
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

    expect(cacheField<string>(cache, cache.entity("Post", "9"), "title").sig()).toBe("Hello");
    expect(cacheField<string>(cache, cache.entity("User", "1"), "name").sig()).toBe("Alice");
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
    expect(cacheField<string>(cache, cache.entity("Todo", "1"), "title").sig()).toBe("Buy milk");
    expect(cacheField<boolean>(cache, cache.entity("Todo", "2"), "done").sig()).toBe(true);
    expect(cacheSlot(cache, "Query.todos.ids").sig()).toStrictEqual(["1", "2"]);
    expect(cacheSlot(cache, "Query.todos.refs").sig()).toStrictEqual([
      { type: "Todo", id: "1" },
      { type: "Todo", id: "2" },
    ]);
  });

  test("normalize writes root entity ref slots", () => {
    const cache = createNormalizedCache();

    cache.normalize({
      viewer: { __typename: "User", id: "1", name: "Alice" },
      todos: [
        { __typename: "Todo", id: "1", title: "Buy milk" },
        { __typename: "Todo", id: "2", title: "Walk dog" },
      ],
    });

    expect(cacheSlot(cache, "Query.viewer").sig()).toStrictEqual({ type: "User", id: "1" });
    expect(cacheSlot(cache, "Query.todos.ids").sig()).toStrictEqual(["1", "2"]);
  });

  test("normalize clears stale list ids when a slot becomes null", () => {
    const cache = createNormalizedCache();

    cache.normalize({
      todos: [
        { __typename: "Todo", id: "1", title: "Buy milk" },
        { __typename: "Todo", id: "2", title: "Walk dog" },
      ],
    });
    expect(cacheSlot(cache, "Query.todos.ids").sig()).toStrictEqual(["1", "2"]);

    cache.normalize({ todos: null });

    expect(cacheSlot(cache, "Query.todos").sig()).toBeNull();
    expect(cacheSlot(cache, "Query.todos.ids").sig()).toBeUndefined();
    expect(isCacheSlotFresh(cache, "Query.todos.ids")).toBe(false);
  });

  test("TTL: normalize with ttl sets expiration", () => {
    const cache = createNormalizedCache();
    const future = Date.now() + 60000;
    cache.normalize({ user: { __typename: "User", id: "1", name: "Alice" } }, 60000);

    const ref = cache.entity("User", "1");
    expect(cacheField<string>(cache, ref, "name").expires).toBeGreaterThanOrEqual(future - 100);
  });

  test("TTL: default ttl of 0 means no expiry", () => {
    const cache = createNormalizedCache();
    cache.normalize({ user: { __typename: "User", id: "1", name: "Alice" } });
    expect(cacheField(cache, cache.entity("User", "1"), "name").expires).toBe(0);
  });

  test("invalidate marks specific fields as stale", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");
    cacheField<string>(cache, ref, "name").sig("Alice");
    cacheField<string>(cache, ref, "avatar").sig("/a.png");

    cache.invalidate({ kind: "entity", ref, paths: [[{ field: "name" }]] });
    expect(cacheField(cache, ref, "name").expires).toBeLessThan(Date.now());
    expect(cacheField(cache, ref, "avatar").expires).toBe(0); // unaffected
  });

  test("invalidate marks relation slot families as stale", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");
    cacheSlot(cache, "User:1.posts").sig([{ type: "Post", id: "10" }]);
    cacheSlot(cache, "User:1.posts.ids").sig(["10"]);
    cacheSlot(cache, "User:1.posts.refs").sig([{ type: "Post", id: "10" }]);

    cache.invalidate({ kind: "entity", ref, paths: [[{ field: "posts" }]] });

    expect(cacheSlot(cache, "User:1.posts").expires).toBeLessThan(Date.now());
    expect(cacheSlot(cache, "User:1.posts.ids").expires).toBeLessThan(Date.now());
    expect(cacheSlot(cache, "User:1.posts.refs").expires).toBeLessThan(Date.now());
  });

  test("invalidate without keys marks all fields stale", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");
    cacheField<string>(cache, ref, "name").sig("Alice");
    cacheField<string>(cache, ref, "avatar").sig("/a.png");
    cacheSlot(cache, "User:1.posts.ids").sig(["10"]);

    cache.invalidate({ kind: "entity", ref });
    expect(cacheField(cache, ref, "name").expires).toBeLessThan(Date.now());
    expect(cacheField(cache, ref, "avatar").expires).toBeLessThan(Date.now());
    expect(cacheSlot(cache, "User:1.posts.ids").expires).toBeLessThan(Date.now());
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
    expect(cacheField<string>(cache, ref, "name").sig()).toBe("ViewerName");
    expect(cacheField<string>(cache, ref, "avatar").sig()).toBe("/pic.png");
  });

  test("normalize handles null fields gracefully", () => {
    const cache = createNormalizedCache();
    cache.normalize({ user: { __typename: "User", id: "1", name: "Alice", avatar: null } });
    expect(cacheField(cache, cache.entity("User", "1"), "avatar").sig()).toBeNull();
  });

  test("normalize keeps non-entity nested JSON as one field value", () => {
    const cache = createNormalizedCache();
    const settings = { theme: "dark", shortcuts: { save: "mod+s" } };

    cache.normalize({ user: { __typename: "User", id: "1", settings } });

    expect(cacheField(cache, cache.entity("User", "1"), "settings").sig()).toStrictEqual(settings);
  });

  test("normalize keeps scalar arrays as one field value", () => {
    const cache = createNormalizedCache();
    const tags = ["typescript", "graphql"];

    cache.normalize({ post: { __typename: "Post", id: "1", tags } });

    expect(cacheField(cache, cache.entity("Post", "1"), "tags").sig()).toStrictEqual(tags);
  });

  test("normalize keeps root scalar arrays as one slot value", () => {
    const cache = createNormalizedCache();
    const tags = ["typescript", "graphql"];

    cache.normalize({ tags });

    expect(cacheSlot(cache, "Query.tags").sig()).toStrictEqual(tags);
    expect(isCacheSlotFresh(cache, "Query.tags.ids")).toBe(false);
  });

  test("created but unset entries are not treated as cached", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");

    cacheField(cache, ref, "name");
    cacheSlot(cache, "Query.viewer");

    expect(isCacheFieldFresh(cache, ref, "name")).toBe(false);
    expect(isCacheSlotFresh(cache, "Query.viewer")).toBe(false);
  });

  test("overlapping normalize calls merge fields without erasing absent ones", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");

    cache.normalize({
      user: { __typename: "User", id: "1", name: "Alice", avatar: "url1" },
    });
    expect(cacheField<string>(cache, ref, "name").sig()).toBe("Alice");
    expect(cacheField<string>(cache, ref, "avatar").sig()).toBe("url1");

    cache.normalize({ user: { __typename: "User", id: "1", name: "Bob" } });

    expect(cacheField<string>(cache, ref, "name").sig()).toBe("Bob");
    expect(cacheField<string>(cache, ref, "avatar").sig()).toBe("url1");
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
    expect(cacheField<string>(cache, cache.entity("A", "1"), "id").sig()).toBe("1");
    expect(cacheField<string>(cache, cache.entity("B", "1"), "name").sig()).toBe("Beta");

    cache.normalize({
      b: {
        __typename: "B",
        id: "1",
        name: "Beta2",
        a: { __typename: "A", id: "1", label: "Alpha" },
      },
    });

    expect(cacheField<string>(cache, cache.entity("B", "1"), "name").sig()).toBe("Beta2");
    expect(cacheField<string>(cache, cache.entity("A", "1"), "label").sig()).toBe("Alpha");
  });

  test("clear removes all fields and slots", () => {
    const cache = createNormalizedCache();
    const ref = cache.entity("User", "1");

    cacheField(cache, ref, "name").sig("Alice");
    cacheSlot(cache, "Query.viewer").sig({ type: "User", id: "1" });

    expect(isCacheFieldFresh(cache, ref, "name")).toBe(true);
    expect(isCacheSlotFresh(cache, "Query.viewer")).toBe(true);

    cache.clear();

    expect(cacheField(cache, ref, "name").sig()).toBeUndefined();
    expect(isCacheFieldFresh(cache, ref, "name")).toBe(false);
    expect(isCacheSlotFresh(cache, "Query.viewer")).toBe(false);
  });
});

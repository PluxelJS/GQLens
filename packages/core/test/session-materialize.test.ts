import { describe, expect, test, vi } from "vitest";
import {
  createNormalizedCache,
  createQuerySession,
  type Fetcher,
  type SelectionPath,
  type SelectionStep,
} from "@gqlens/core";
import { cacheField } from "./cache-helpers";

const p = (steps: SelectionStep[]): SelectionPath => ({
  root: "Query",
  steps,
});

describe("QuerySession cache materialization", () => {
  test("syncs aliased root embedded value object leaves to owner fields", async () => {
    const cache = createNormalizedCache();
    const session = createQuerySession({
      cache,
      fetcher: async () => ({
        user_0: {
          __typename: "User",
          id: "1",
          status: { online: true, source: { kind: "hmr" } },
        },
        user_1: {
          __typename: "User",
          id: "2",
          status: { online: false, source: { kind: "package" } },
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
    session.select(reader, {
      root: "Query",
      steps: [{ field: "user", args: { id: "2" } }, { field: "status" }, { field: "online" }],
    });
    session.schedule();
    await nextMacrotask();

    expect(cacheField<string>(cache, cache.entity("User", "1"), "status.source.kind").sig()).toBe(
      "hmr",
    );
    expect(cacheField<boolean>(cache, cache.entity("User", "2"), "status.online").sig()).toBe(
      false,
    );
  });

  test("treats aliased root embedded value object leaves as fresh across sessions", async () => {
    const cache = createNormalizedCache();
    const metadata = valueObjectMetadata();
    const paths = [
      p([
        { field: "user", args: { id: "1" } },
        { field: "status" },
        { field: "source" },
        { field: "kind" },
      ]),
      p([
        { field: "user", args: { id: "2" } },
        { field: "status" },
        { field: "source" },
        { field: "kind" },
      ]),
    ];
    const firstFetch = vi.fn<Fetcher>(async () => ({
      user_0: {
        __typename: "User",
        id: "1",
        status: { online: true, source: { kind: "hmr" } },
      },
      user_1: {
        __typename: "User",
        id: "2",
        status: { online: false, source: { kind: "package" } },
      },
    }));
    const firstSession = createQuerySession({
      cache,
      fetcher: firstFetch,
      policy: "cache-first",
      metadata,
    });
    const firstReader = firstSession.mount();
    firstSession.replace(firstReader, paths);
    firstSession.schedule();
    await nextMacrotask();

    const secondFetch = vi.fn<Fetcher>(async () => ({}));
    const secondSession = createQuerySession({
      cache,
      fetcher: secondFetch,
      policy: "cache-first",
      metadata,
    });
    const secondReader = secondSession.mount();
    secondSession.replace(secondReader, paths);
    secondSession.schedule();
    await nextMicrotask();

    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).not.toHaveBeenCalled();
  });

  test("clears selected owner leaves and stays fresh for aliased root null value objects", async () => {
    const cache = createNormalizedCache();
    const metadata = valueObjectMetadata();
    cache.normalize(
      {
        user: {
          __typename: "User",
          id: "1",
          status: { online: true, source: { kind: "hmr" } },
        },
      },
      0,
      metadata,
    );
    const paths = [
      p([
        { field: "user", args: { id: "1" } },
        { field: "status" },
        { field: "source" },
        { field: "kind" },
      ]),
      p([
        { field: "user", args: { id: "2" } },
        { field: "status" },
        { field: "source" },
        { field: "kind" },
      ]),
    ];
    const firstFetch = vi.fn<Fetcher>(async () => ({
      user_0: {
        __typename: "User",
        id: "1",
        status: { online: true, source: null },
      },
      user_1: {
        __typename: "User",
        id: "2",
        status: null,
      },
    }));
    const firstSession = createQuerySession({
      cache,
      fetcher: firstFetch,
      policy: "network-only",
      metadata,
    });
    const firstReader = firstSession.mount();
    firstSession.replace(firstReader, paths);
    firstSession.schedule();
    await nextMacrotask();

    const secondFetch = vi.fn<Fetcher>(async () => ({}));
    const secondSession = createQuerySession({
      cache,
      fetcher: secondFetch,
      policy: "cache-first",
      metadata,
    });
    const secondReader = secondSession.mount();
    secondSession.replace(secondReader, paths);
    secondSession.schedule();
    await nextMicrotask();

    expect(
      cacheField(cache, cache.entity("User", "1"), "status.source.kind").sig(),
    ).toBeUndefined();
    expect(
      cacheField(cache, cache.entity("User", "2"), "status.source.kind").sig(),
    ).toBeUndefined();
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).not.toHaveBeenCalled();
  });
});

function nextMicrotask(): Promise<void> {
  return Promise.resolve();
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

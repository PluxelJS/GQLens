import { describe, expect, test } from "vitest";
import { SieveCache } from "../src/sieve-cache";

describe("SieveCache", () => {
  test("returns cached values and updates existing entries", () => {
    const cache = new SieveCache<string, number>(2);

    cache.set("a", 1);
    cache.set("a", 2);

    expect(cache.get("a")).toBe(2);
    expect(cache.get("missing")).toBeUndefined();
  });

  test("gives visited entries a second chance before eviction", () => {
    const cache = new SieveCache<string, number>(2);

    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  test("does not keep visited entries permanently", () => {
    const cache = new SieveCache<string, number>(2);

    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    cache.set("d", 4);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  test("treats non-positive or non-finite capacity as disabled", () => {
    for (const capacity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cache = new SieveCache<string, number>(capacity);
      cache.set("a", 1);

      expect(cache.get("a")).toBeUndefined();
    }
  });
});

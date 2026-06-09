import { describe, expect, test } from "vitest";
import { createSelectionCollector, type SelectionPath } from "@gqlens/core";

const makePath = (root: string, steps: string[]): SelectionPath => ({
  root,
  steps: steps.map((s) => ({ field: s })),
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

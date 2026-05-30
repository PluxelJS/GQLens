import { describe, expect, test } from "vitest";

import { useLens } from "@gqlens/react";

describe("useLens", () => {
  test("is a function", () => {
    expect(typeof useLens).toBe("function");
  });
});

import { describe, expect, test } from "vitest";

import { createLensResource } from "@gqlens/solid";

describe("createLensResource", () => {
  test("returns a function", () => {
    const resource = createLensResource({ query: "{ hello }", shape: {} });

    expect(typeof resource).toBe("function");
    expect(resource()).toStrictEqual({});
  });
});

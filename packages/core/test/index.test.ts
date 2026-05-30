import { describe, expect, test } from "vitest";

import { createLens } from "@gqlens/core";

describe("createLens", () => {
  test("creates a lens from a query string", () => {
    const lens = createLens({ query: "{ hello }" });

    expect(lens.query).toStrictEqual("{ hello }");
    expect(lens.shape).toStrictEqual({});
  });
});

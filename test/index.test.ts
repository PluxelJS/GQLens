import { describe, expect, test } from "vitest";

import { createGreeting } from "../src/index.ts";

describe("createGreeting", () => {
  test("returns a friendly greeting", () => {
    expect(createGreeting({ name: "Ada" })).toStrictEqual("Hello, Ada!");
  });
});

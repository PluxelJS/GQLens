import { describe, expect, test } from "vitest";
import { createFetchTransport } from "@gqlens/core";

// ─── Transport ─────────────────────────────────────────────────────────────

describe("FetchTransport", () => {
  test("creates a valid fetcher function", () => {
    const fetch = createFetchTransport("/graphql");
    expect(typeof fetch).toBe("function");
  });
});

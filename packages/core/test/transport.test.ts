import { afterEach, describe, expect, test, vi } from "vitest";
import { createFetchTransport } from "@gqlens/core";

// ─── Transport ─────────────────────────────────────────────────────────────

describe("FetchTransport", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("creates a valid fetcher function", () => {
    const fetch = createFetchTransport("/graphql");
    expect(typeof fetch).toBe("function");
  });

  test("forwards the caller-owned abort signal", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return Response.json({ data: { ok: true } });
    });
    vi.stubGlobal("fetch", request);

    await expect(
      createFetchTransport("/graphql")(
        { query: "query Test { ok }", variables: {}, operationName: "Test", selections: [] },
        { signal: controller.signal },
      ),
    ).resolves.toStrictEqual({ ok: true });
  });
});

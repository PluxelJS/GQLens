import { node } from "@elysiajs/node";
import { Elysia } from "elysia";

import { createYogaHandler } from "./yoga";

export function createHttpApp() {
  const yoga = createYogaHandler();
  const handleGraphQLRequest = async ({ request }: { readonly request: Request }) =>
    normalizeResponse(await yoga.fetch(request));

  return new Elysia({ adapter: node() })
    .all("/graphql", handleGraphQLRequest)
    .all("/graphql/*", handleGraphQLRequest)
    .get("/health", () => ({ ok: true, service: "example-api" }));
}

function normalizeResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { createYoga } from "graphql-yoga";

import { createAppContext } from "./context";
import { createSchema } from "./schema";

export type GraphQLNodeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => unknown | Promise<unknown>;

export type GraphQLYogaHandler = GraphQLNodeHandler & {
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export function createYogaHandler(): GraphQLYogaHandler {
  const yoga = createYoga({
    schema: createSchema(),
    graphqlEndpoint: "/graphql",
    graphiql: true,
    context: createAppContext,
    maskedErrors: process.env.NODE_ENV === "production",
    logging: process.env.NODE_ENV === "development" ? "debug" : "warn",
  });

  return yoga as GraphQLYogaHandler;
}

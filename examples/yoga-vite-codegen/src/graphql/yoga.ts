import { createYoga } from "graphql-yoga";

import { createAppContext } from "./context";
import { createSchema } from "./schema";

export function createYogaHandler() {
  return createYoga({
    schema: createSchema(),
    graphqlEndpoint: "/graphql",
    context: createAppContext,
    maskedErrors: process.env.NODE_ENV === "production",
    logging: process.env.NODE_ENV === "development" ? "debug" : "warn",
  });
}

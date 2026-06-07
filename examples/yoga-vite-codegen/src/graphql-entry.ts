import { defineGraphQLEntry } from "../tooling/graphql-entry.ts";
import { createSchemaSDL } from "./schema.ts";

export default defineGraphQLEntry({
  schema: createSchemaSDL,
  handler: async (server) => {
    const mod = (await server.ssrLoadModule("/src/yoga.ts")) as typeof import("./yoga.ts");
    return mod.createYogaHandler();
  },
});

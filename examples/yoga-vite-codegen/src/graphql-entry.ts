import { defineGQLensEntry } from "@gqlens/vite/entry";
import { createSchemaSDL } from "./schema.ts";
import type { GraphQLNodeHandler } from "./yoga.ts";

export default defineGQLensEntry({
  schema: createSchemaSDL,
  handler: async (server): Promise<GraphQLNodeHandler> => {
    const mod = (await server.ssrLoadModule("/src/yoga.ts")) as typeof import("./yoga.ts");
    return mod.createYogaHandler();
  },
});

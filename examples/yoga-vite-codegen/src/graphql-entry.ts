import type { GraphQLPluginEntry } from "../tooling/graphql-entry.ts";
import { createSchemaSDL } from "./schema.ts";

export default {
  schema: createSchemaSDL,
  handler: async (context) => {
    const mod = await context.importModule<typeof import("./yoga")>("/src/yoga.ts");
    return mod.createYogaHandler();
  },
} satisfies GraphQLPluginEntry;

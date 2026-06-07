import { defineGraphQLHMR } from "../tooling/graphql-hmr.ts";
import { createSchemaSDL } from "./schema.ts";

export default defineGraphQLHMR({
  schema: () => createSchemaSDL(),
  buildSchema: createSchemaSDL,
  handler: async (context) => {
    const mod = await context.importModule<typeof import("./yoga")>("/src/yoga.ts");
    return mod.createYogaHandler();
  },
});

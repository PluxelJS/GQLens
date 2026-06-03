import { printSchema } from "graphql";

import { createSchema } from "./schema";

export function createSchemaSDL(): string {
  return printSchema(createSchema());
}

if (import.meta.hot) {
  import.meta.hot.accept();
}

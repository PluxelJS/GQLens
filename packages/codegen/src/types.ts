import { codegen } from "@graphql-codegen/core";
import * as typescriptPlugin from "@graphql-codegen/typescript";
import { parse } from "graphql";
import { typescriptPluginConfig } from "./type-names";

export async function generateTypes(schemaSDL: string): Promise<string> {
  const result = await codegen({
    filename: "types.ts",
    schema: parse(schemaSDL),
    documents: [],
    pluginMap: {
      typescript: typescriptPlugin as never,
    },
    plugins: [{ typescript: typescriptPluginConfig }],
    config: {},
  });

  return String(result);
}

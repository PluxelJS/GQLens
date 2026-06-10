/**
 * Orchestrates generation of all output files.
 */

import { parse, buildASTSchema, printSchema, type GraphQLSchema } from "graphql";
import { resolveAdapter, type AccessorAdapter, type BuiltInFramework } from "./adapters";
import { generateTypes } from "./types";
import { generateInvalidation } from "./invalidation";
import { generateAccessor } from "./accessor";
import { validateEntitySchemaContract } from "./utils";
import { GQLensCodegenError } from "./error";

export type SchemaInput = string | GraphQLSchema;

export interface GenerateFilesOptions {
  readonly schema: SchemaInput;
  readonly framework?: BuiltInFramework | undefined;
  readonly adapter?: AccessorAdapter | undefined;
}

export type GeneratedFiles = Readonly<Record<string, string>>;

export async function generateFiles(options: GenerateFilesOptions): Promise<GeneratedFiles> {
  const schemaSDL = schemaToSDL(options.schema);
  const schema = parseSchemaSDL(schemaSDL);
  const adapter = resolveAdapter(options.framework, options.adapter);
  validateEntitySchemaContract(schema);

  const files: Record<string, string> = {};
  files["types.ts"] = await generateTypes(schemaSDL);
  files["invalidation.ts"] = generateInvalidation(schema);
  files["accessor.ts"] = generateAccessor(schema, adapter);

  return files;
}

function parseSchemaSDL(schemaSDL: string): GraphQLSchema {
  try {
    return buildASTSchema(parse(schemaSDL));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GQLensCodegenError({
      code: "INVALID_SCHEMA_INPUT",
      message: "Invalid GraphQL schema SDL.",
      details: { cause: message },
    });
  }
}

export function schemaToSDL(schema: SchemaInput): string {
  if (typeof schema === "string") {
    return schema;
  }
  if (isGraphQLSchemaLike(schema)) {
    try {
      return printSchema(schema);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GQLensCodegenError({
        code: "INVALID_SCHEMA_INPUT",
        message:
          "Unable to print GraphQLSchema. Pass SDL string when schema and codegen may resolve different graphql package instances.",
        details: { cause: message },
      });
    }
  }
  throw new GQLensCodegenError({
    code: "INVALID_SCHEMA_INPUT",
    message: "Expected GraphQL SDL string or GraphQLSchema.",
  });
}

function isGraphQLSchemaLike(value: unknown): value is GraphQLSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    "getTypeMap" in value &&
    typeof value.getTypeMap === "function"
  );
}

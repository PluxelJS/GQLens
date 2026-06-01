/**
 * @gqlens/codegen — entry point. Orchestrates generation of all output files.
 */

import { parse, buildASTSchema } from "graphql";
import { generateTypes } from "./types";
import { generateNormalizer, generateInvalidation } from "./normalizer";
import { generateAccessor } from "./accessor";

export interface GenerateOptions {
  readonly schema: string;
  readonly output: string;
  readonly framework?: "react" | "solid" | undefined;
}

export interface GenerateResult {
  readonly typesFile: string;
  readonly normalizerFile: string;
  readonly invalidationFile: string;
  readonly accessorFile: string;
  readonly files: Readonly<Record<string, string>>;
}

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const schema = buildASTSchema(parse(options.schema));
  const adapter = (options.framework ?? "react") === "solid" ? "@gqlens/solid" : "@gqlens/react";

  const files: Record<string, string> = {};
  files["types.ts"] = await generateTypes(options.schema);
  files["normalizer.ts"] = generateNormalizer(schema);
  files["invalidation.ts"] = generateInvalidation(schema);
  files["accessor.ts"] = generateAccessor(schema, adapter);

  return {
    typesFile: `${options.output}/types.ts`,
    normalizerFile: `${options.output}/normalizer.ts`,
    invalidationFile: `${options.output}/invalidation.ts`,
    accessorFile: `${options.output}/accessor.ts`,
    files,
  };
}

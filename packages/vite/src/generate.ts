import type { generateFiles, GenerateFilesOptions, schemaToSDL } from "@gqlens/codegen";
import { buildASTSchema, parse, printSchema } from "graphql";
import { writeGeneratedMetadata } from "./generated-metadata";
import { writeGeneratedFiles, type GeneratedWriteStats } from "./write-generated-files";

export interface GenerateGQLensFilesOptions extends GenerateFilesOptions {
  readonly output: string;
}

export async function generateGQLensFiles(
  options: GenerateGQLensFilesOptions,
): Promise<GeneratedWriteStats> {
  const { generateFiles, schemaToSDL } = await loadCodegen();
  const { output, ...generateOptions } = options;
  const schema = normalizeSchemaSDL(schemaToSDL(options.schema));
  const files = await generateFiles({ ...generateOptions, schema });
  const writeStats = await writeGeneratedFiles(files, output);
  await writeGeneratedMetadata({ ...generateOptions, schema, output, files });
  return writeStats;
}

async function loadCodegen(): Promise<{
  generateFiles: typeof generateFiles;
  schemaToSDL: typeof schemaToSDL;
}> {
  return import("@gqlens/codegen");
}

function normalizeSchemaSDL(sdl: string): string {
  return printSchema(buildASTSchema(parse(sdl)));
}

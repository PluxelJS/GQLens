import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { GenerateFilesOptions } from "@gqlens/codegen";

const metadataFileName = ".gqlens-meta.json";
const metadataVersion = 1;

interface GeneratedMetadata {
  readonly version: typeof metadataVersion;
  readonly codegenVersion: string;
  readonly schemaHash: string;
  readonly optionsHash: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface GeneratedMetadataOptions extends Pick<
  GenerateFilesOptions,
  "schema" | "framework" | "adapter"
> {
  readonly output: string;
}

export interface WriteGeneratedMetadataOptions extends GeneratedMetadataOptions {
  readonly files: Readonly<Record<string, string>>;
}

export async function generatedFilesAreCurrent(
  options: GeneratedMetadataOptions,
): Promise<boolean> {
  const metadata = await readMetadata(options.output);
  if (!metadata) {
    return false;
  }

  if (!metadataMatches(metadata, options)) {
    return false;
  }

  try {
    const fileHashes = await readGeneratedFileHashes(options.output, Object.keys(metadata.files));
    return stableStringify(fileHashes) === stableStringify(metadata.files);
  } catch {
    return false;
  }
}

export async function writeGeneratedMetadata(
  options: WriteGeneratedMetadataOptions,
): Promise<void> {
  await writeFile(
    metadataPath(options.output),
    `${JSON.stringify(createMetadata(options), null, 2)}\n`,
    "utf8",
  );
}

function createMetadata(options: WriteGeneratedMetadataOptions): GeneratedMetadata {
  return {
    version: metadataVersion,
    codegenVersion: codegenVersion(),
    schemaHash: hashString(String(options.schema)),
    optionsHash: optionsHash(options),
    files: hashFiles(options.files),
  };
}

function metadataMatches(metadata: GeneratedMetadata, options: GeneratedMetadataOptions): boolean {
  return (
    metadata.version === metadataVersion &&
    metadata.codegenVersion === codegenVersion() &&
    metadata.schemaHash === hashString(String(options.schema)) &&
    metadata.optionsHash === optionsHash(options)
  );
}

async function readMetadata(output: string): Promise<GeneratedMetadata | undefined> {
  try {
    return parseMetadata(await readFile(metadataPath(output), "utf8"));
  } catch {
    return undefined;
  }
}

function parseMetadata(content: string): GeneratedMetadata | undefined {
  const value = JSON.parse(content) as unknown;
  if (!isGeneratedMetadata(value)) {
    return undefined;
  }
  return value;
}

function isGeneratedMetadata(value: unknown): value is GeneratedMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === metadataVersion &&
    "codegenVersion" in value &&
    typeof value.codegenVersion === "string" &&
    "schemaHash" in value &&
    typeof value.schemaHash === "string" &&
    "optionsHash" in value &&
    typeof value.optionsHash === "string" &&
    "files" in value &&
    isStringRecord(value.files)
  );
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

async function readGeneratedFileHashes(
  output: string,
  names: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const entries = await Promise.all(
    names.map(
      async (name) => [name, hashString(await readFile(join(output, name), "utf8"))] as const,
    ),
  );
  return Object.fromEntries(entries);
}

function hashFiles(files: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(files).map(([name, content]) => [name, hashString(content)] as const),
  );
}

function optionsHash(options: Pick<GenerateFilesOptions, "framework" | "adapter">): string {
  return hashString(
    stableStringify({
      adapter: options.adapter ?? null,
      framework: options.framework ?? null,
    }),
  );
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function metadataPath(output: string): string {
  return join(output, metadataFileName);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function codegenVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require("@gqlens/codegen/package.json") as { readonly version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

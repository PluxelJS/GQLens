import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isSchema, printSchema, type GraphQLSchema } from "graphql";
import { generate, type GenerateOptions } from "./generate";

type MaybePromise<T> = T | Promise<T>;
type SchemaInput = string | GraphQLSchema;
type SchemaLoader = () => MaybePromise<SchemaInput>;
type RolldownWarning = string | { readonly message: string };

interface PluginContextLike {
  addWatchFile?(id: string): void;
  warn?(warning: RolldownWarning): void;
  error?(error: Error | string): never;
}

interface TransformMetaLike {
  readonly moduleType?: string | undefined;
}

type HookPattern = string | RegExp | readonly (string | RegExp)[];

interface TransformFilter {
  readonly id?: HookPattern | undefined;
  readonly code?: HookPattern | undefined;
}

interface TransformHook {
  readonly filter: TransformFilter;
  handler(this: PluginContextLike, code: string, id: string, meta?: TransformMetaLike): null;
}

export interface GQLensRolldownPlugin {
  readonly name: "gqlens-codegen";
  buildStart(this: PluginContextLike): Promise<void>;
  readonly transform: TransformHook;
  watchChange(this: PluginContextLike, id: string): Promise<void>;
  buildEnd(this: PluginContextLike): Promise<void>;
}

export interface GQLensRolldownOptions extends Omit<GenerateOptions, "schema" | "output"> {
  readonly output: string;
  readonly schema?: SchemaInput | SchemaLoader | undefined;
  readonly schemaModule?: string | undefined;
  readonly schemaExport?: string | readonly string[] | undefined;
  readonly watch?: readonly (string | RegExp)[] | undefined;
  readonly cwd?: string | undefined;
  readonly filter?: TransformFilter | undefined;
}

const defaultFilter = {
  id: /\.(?:[cm]?[jt]sx?|graphql)(?:\?.*)?$/,
  code: /\b(?:printSchema|GraphQLSchema|schemaSDL|gqlensCodegenSchema)\b|from\s+["']graphql["']/,
} satisfies TransformFilter;

const defaultExportNames = [
  "default",
  "schema",
  "schemaSDL",
  "sdl",
  "gqlensCodegenSchema",
] as const;

export function gqlensRolldown(options: GQLensRolldownOptions): GQLensRolldownPlugin {
  const candidates = new Set<string>();
  const cwd = options.cwd ?? process.cwd();
  const filter = options.filter ?? defaultFilter;
  let generated = false;

  return {
    name: "gqlens-codegen",

    async buildStart(): Promise<void> {
      candidates.clear();
      generated = false;
      if (options.schemaModule) {
        const schemaModule = resolvePath(cwd, options.schemaModule);
        candidates.add(schemaModule);
        this.addWatchFile?.(schemaModule);
      }
      if (options.schema || options.schemaModule) {
        await runGeneration(options, cwd, candidates);
        generated = true;
      }
    },

    transform: {
      filter,
      handler(code, id): null {
        const file = cleanId(id);
        if (isGraphQLFile(file) || defaultFilter.code.test(code)) {
          candidates.add(file);
          this.addWatchFile?.(file);
        }
        return null;
      },
    },

    async watchChange(id): Promise<void> {
      const file = cleanId(id);
      if (!shouldRegenerateForChange(file, options, cwd, candidates)) {
        return;
      }
      try {
        await runGeneration(options, cwd, candidates);
        generated = true;
      } catch (error) {
        const message = error instanceof Error ? error : new Error(String(error));
        this.error?.(message);
        throw message;
      }
    },

    async buildEnd(): Promise<void> {
      if (generated) {
        return;
      }
      try {
        await runGeneration(options, cwd, candidates);
      } catch (error) {
        const message = error instanceof Error ? error : new Error(String(error));
        this.error?.(message);
        throw message;
      }
    },
  };
}

function shouldRegenerateForChange(
  file: string,
  options: GQLensRolldownOptions,
  cwd: string,
  candidates: ReadonlySet<string>,
): boolean {
  if (candidates.has(file)) {
    return true;
  }
  if (options.schemaModule && resolvePath(cwd, options.schemaModule) === file) {
    return true;
  }
  return options.watch?.some((rule) => matchesRule(file, rule)) ?? false;
}

async function runGeneration(
  options: GQLensRolldownOptions,
  cwd: string,
  candidates: ReadonlySet<string>,
): Promise<void> {
  const schema = await resolveSchema(options, candidates);
  const result = await generate({
    schema,
    output: options.output,
    framework: options.framework,
    adapter: options.adapter,
  });
  await writeGeneratedFiles(result.files, resolvePath(cwd, options.output));
}

async function resolveSchema(
  options: GQLensRolldownOptions,
  candidates: ReadonlySet<string>,
): Promise<string> {
  if (typeof options.schema === "string") {
    return options.schema;
  }
  if (typeof options.schema === "function") {
    return schemaToSDL(await options.schema());
  }
  if (options.schema) {
    return schemaToSDL(options.schema);
  }

  const exportNames = normalizeExportNames(options.schemaExport);
  const schemas = await Promise.all(
    [...candidates].map((candidate) => tryLoadSchemaModule(candidate, exportNames)),
  );
  const schema = schemas.find((item) => item !== undefined);
  if (schema) {
    return schema;
  }

  const hint =
    candidates.size > 0
      ? `Checked ${candidates.size} candidate module(s), but none exported a schema.`
      : "No schema candidate reached the rolldown module graph.";
  throw new Error(
    `${hint} Export SDL or GraphQLSchema as default/schema/schemaSDL/sdl, or pass schema/schemaModule explicitly.`,
  );
}

async function tryLoadSchemaModule(
  file: string,
  exportNames: readonly string[],
): Promise<string | undefined> {
  if (isGraphQLFile(file)) {
    return readFile(file, "utf8");
  }

  const moduleUrl = pathToFileURL(file);
  moduleUrl.searchParams.set("gqlens", String(Date.now()));
  let mod: Record<string, unknown>;
  try {
    mod = (await import(moduleUrl.href)) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const values = await Promise.all(
    exportNames.map((name) => (name in mod ? resolveExportValue(mod[name]) : undefined)),
  );
  const schema = values.find((item) => item !== undefined);
  if (schema) {
    return schema;
  }

  return undefined;
}

async function resolveExportValue(value: unknown): Promise<string | undefined> {
  const resolved = typeof value === "function" ? await (value as SchemaLoader)() : value;
  if (typeof resolved === "string") {
    return resolved;
  }
  if (isSchema(resolved)) {
    return printSchema(resolved);
  }
  return undefined;
}

function schemaToSDL(schema: SchemaInput): string {
  return typeof schema === "string" ? schema : printSchema(schema);
}

async function writeGeneratedFiles(
  files: Readonly<Record<string, string>>,
  output: string,
): Promise<void> {
  await mkdir(output, { recursive: true });
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      const file = join(output, name);
      await mkdir(dirname(file), { recursive: true });
      if ((await readExisting(file)) === content) {
        return;
      }
      await writeFile(file, content, "utf8");
    }),
  );
}

async function readExisting(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function normalizeExportNames(value: string | readonly string[] | undefined): readonly string[] {
  if (!value) {
    return defaultExportNames;
  }
  return typeof value === "string" ? [value] : value;
}

function resolvePath(cwd: string, value: string): string {
  return isAbsolute(value) ? value : join(cwd, value);
}

function cleanId(id: string): string {
  return id.replace(/[?#].*$/, "");
}

function isGraphQLFile(file: string): boolean {
  return /\.(?:gql|graphql)$/.test(file);
}

function matchesRule(file: string, rule: string | RegExp): boolean {
  return typeof rule === "string" ? file.includes(rule) : rule.test(file);
}

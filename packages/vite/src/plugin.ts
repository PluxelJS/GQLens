import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { generateFiles as generateFilesFunction, GenerateFilesOptions } from "@gqlens/codegen";
import { buildASTSchema, parse, printSchema } from "graphql";
import { normalizePath, type Plugin, type ResolvedConfig, type ViteDevServer } from "vite";
import type { GQLensViteEntry, NodeHandler } from "./entry";
import { GQLensViteError } from "./error";
import { generatedFilesAreCurrent, writeGeneratedMetadata } from "./generated-metadata";
import { writeGeneratedFiles } from "./write-generated-files";

type GenerateFiles = typeof generateFilesFunction;

type GQLensViteEntryModule = {
  readonly default?: unknown;
};

export interface GQLensViteLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  error(error: Error, properties?: Record<string, unknown>): void;
}

export interface GQLensVitePluginOptions extends Omit<GenerateFilesOptions, "schema"> {
  readonly output: string;
  readonly entry: string;
  readonly endpoint?: string | undefined;
  readonly include?: readonly (string | RegExp)[] | undefined;
  readonly logger?: GQLensViteLogger | undefined;
  readonly middleware?: boolean | undefined;
}

export function gqlens(options: GQLensVitePluginOptions): Plugin {
  const logger = options.logger ?? noopLogger;
  const endpoint = options.endpoint ?? "/graphql";
  const entryId = options.entry;
  const include = options.include ?? [/\/src\//];
  const enableMiddleware = options.middleware ?? true;

  let config: ResolvedConfig;
  let server: ViteDevServer | undefined;
  let devEntry: Promise<GQLensViteEntry> | undefined;
  let handler: Promise<NodeHandler> | undefined;
  let refreshQueue: Promise<void> = Promise.resolve();
  let generateFiles: Promise<GenerateFiles> | undefined;
  let lastSDL: string | undefined;

  function isIncluded(file: string): boolean {
    const normalized = normalizePath(file);
    if (normalized === normalizePath(entryPath())) {
      return true;
    }
    return include.some((rule) =>
      typeof rule === "string" ? normalized.includes(rule) : rule.test(normalized),
    );
  }

  function rootPath(value: string): string {
    return isAbsolute(value) ? value : join(config.root, value);
  }

  function entryPath(): string {
    if (entryId.startsWith("/") && !normalizePath(entryId).startsWith(normalizePath(config.root))) {
      return join(config.root, entryId.slice(1));
    }
    return rootPath(entryId);
  }

  function isGraphQLRequest(url: string | undefined): boolean {
    if (!url) {
      return false;
    }

    const { pathname } = new URL(url, "http://vite.local");
    return pathname === endpoint || pathname.startsWith(`${endpoint}/`);
  }

  function devServer(): ViteDevServer {
    if (!server) {
      throw new GQLensViteError({
        code: "DEV_SERVER_NOT_READY",
        message: "[gqlens/vite] Vite dev server is not ready.",
      });
    }
    return server;
  }

  async function loadDevSchemaSDL(): Promise<string> {
    const entry = await loadDevEntry();
    return normalizeSchemaSDL(await entry.schema(), entryId);
  }

  async function loadDevHandler(): Promise<NodeHandler> {
    const viteServer = devServer();
    const entry = await loadDevEntry();
    if (!entry.handler) {
      throw new GQLensViteError({
        code: "MISSING_HANDLER",
        message:
          "[gqlens/vite] GraphQL middleware requires defineGQLensEntry({ handler }). Set middleware: false when using an external GraphQL server.",
      });
    }
    handler ??= Promise.resolve(entry.handler(viteServer));
    return handler;
  }

  async function loadDevEntry(): Promise<GQLensViteEntry> {
    devEntry ??= (async () => {
      const mod = (await devServer().ssrLoadModule(entryId)) as GQLensViteEntryModule;
      return readGQLensEntry(mod.default, entryId);
    })();
    return devEntry;
  }

  async function loadBuildEntry(): Promise<GQLensViteEntry> {
    const mod = (await import(pathToFileURL(entryPath()).href)) as GQLensViteEntryModule;
    return readGQLensEntry(mod.default, entryId);
  }

  async function loadGenerateFiles(): Promise<GenerateFiles> {
    generateFiles ??= (async () => {
      const require = createRequire(join(config.root, "package.json"));
      const resolved = resolveCodegen(require);
      const mod = (await import(resolved ? pathToFileURL(resolved).href : "@gqlens/codegen")) as {
        readonly generateFiles: GenerateFiles;
      };
      return mod.generateFiles;
    })();
    return generateFiles;
  }

  async function refreshGeneratedFiles(force: boolean): Promise<void> {
    const startedAt = performance.now();
    const sdl = await loadDevSchemaSDL();
    const schemaChanged = lastSDL !== sdl;
    lastSDL = sdl;

    if (!force && !schemaChanged) {
      logger.debug("Skipped GQLens codegen because SDL is unchanged.", {
        entry: entryId,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return;
    }

    const output = rootPath(options.output);
    if (
      force &&
      (await generatedFilesAreCurrent({
        schema: sdl,
        framework: options.framework,
        adapter: options.adapter,
        output,
      }))
    ) {
      logger.debug("Skipped GQLens startup codegen because generated files are current.", {
        entry: entryId,
        output: options.output,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return;
    }

    const files = await (
      await loadGenerateFiles()
    )({
      schema: sdl,
      framework: options.framework,
      adapter: options.adapter,
    });
    const writeStats = await writeGeneratedFiles(files, output);
    await writeGeneratedMetadata({
      schema: sdl,
      framework: options.framework,
      adapter: options.adapter,
      output,
      files,
    });
    logger.info("Refreshed GQLens generated files.", {
      reason: force ? "startup" : "schema-changed",
      entry: entryId,
      output: options.output,
      durationMs: Math.round(performance.now() - startedAt),
      files: writeStats.total,
      changed: writeStats.changed,
      skipped: writeStats.skipped,
    });
  }

  async function generateBuildFiles(): Promise<void> {
    const startedAt = performance.now();
    const entry = await loadBuildEntry();
    const schema = normalizeSchemaSDL(await entry.schema(), entryPath());
    const output = rootPath(options.output);
    if (
      await generatedFilesAreCurrent({
        schema,
        framework: options.framework,
        adapter: options.adapter,
        output,
      })
    ) {
      logger.debug("Skipped GQLens build codegen because generated files are current.", {
        output: options.output,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return;
    }

    const files = await (
      await loadGenerateFiles()
    )({
      schema,
      framework: options.framework,
      adapter: options.adapter,
    });
    const writeStats = await writeGeneratedFiles(files, output);
    await writeGeneratedMetadata({
      schema,
      framework: options.framework,
      adapter: options.adapter,
      output,
      files,
    });
    logger.info("Generated GQLens files for build in {durationMs}ms.", {
      durationMs: Math.round(performance.now() - startedAt),
      output: options.output,
      files: writeStats.total,
      changed: writeStats.changed,
      skipped: writeStats.skipped,
    });
  }

  function enqueueRefresh(force: boolean): Promise<void> {
    refreshQueue = refreshQueue.then(
      () => refreshGeneratedFiles(force),
      () => refreshGeneratedFiles(force),
    );
    return refreshQueue;
  }

  async function handleGraphQLRequest(
    req: Parameters<NodeHandler>[0],
    res: Parameters<NodeHandler>[1],
    next: (error?: unknown) => void,
  ): Promise<void> {
    try {
      const currentHandler = await loadDevHandler();
      await currentHandler(req, res);
    } catch (error) {
      handler = undefined;
      logger.error(error instanceof Error ? error : new Error(String(error)), {
        endpoint,
      });
      next(error);
    }
  }

  return {
    name: "gqlens-vite",
    enforce: "pre",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    async buildStart() {
      if (config.command !== "build") {
        return;
      }
      await generateBuildFiles();
    },

    async configureServer(viteServer) {
      server = viteServer;
      await enqueueRefresh(true);

      if (!enableMiddleware) {
        logger.info("GraphQL middleware disabled; Vite will proxy {endpoint}.", {
          endpoint,
        });
        return;
      }

      viteServer.middlewares.use((req, res, next) => {
        if (!isGraphQLRequest(req.url)) {
          next();
          return;
        }

        void handleGraphQLRequest(req, res, next);
      });
    },

    async handleHotUpdate(ctx) {
      if (!isIncluded(ctx.file)) {
        return;
      }

      handler = undefined;
      devEntry = undefined;
      logger.debug("GraphQL-related module changed; refreshing handler and generated files.", {
        file: normalizePath(ctx.file),
      });
      await enqueueRefresh(false);
      return ctx.modules;
    },
  };
}

const noopLogger: GQLensViteLogger = {
  debug: noop,
  info: noop,
  error: noop,
};

function readGQLensEntry(value: unknown, source: string): GQLensViteEntry {
  if (!isGQLensEntry(value)) {
    throw new GQLensViteError({
      code: "INVALID_ENTRY",
      message: `[gqlens/vite] ${source} must default-export defineGQLensEntry({ schema, ... }).`,
    });
  }

  return value;
}

function normalizeSchemaSDL(sdl: string, source: string): string {
  try {
    return printSchema(buildASTSchema(parse(sdl)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GQLensViteError({
      code: "INVALID_SCHEMA",
      message: `[gqlens/vite] ${source} returned invalid GraphQL SDL.`,
      details: { cause: message },
    });
  }
}

function isGQLensEntry(value: unknown): value is GQLensViteEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    typeof value.schema === "function" &&
    (!("handler" in value) || value.handler === undefined || typeof value.handler === "function")
  );
}

function noop(): void {
  return undefined;
}

function resolveCodegen(require: NodeJS.Require): string | undefined {
  try {
    return require.resolve("@gqlens/codegen");
  } catch {
    return undefined;
  }
}

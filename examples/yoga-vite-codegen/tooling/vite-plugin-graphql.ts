import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { printSchema } from "graphql";
import { generateFiles, type GenerateFilesOptions } from "../../../packages/codegen/src/index";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { isRunnableDevEnvironment, normalizePath } from "vite";
import type {
  GraphQLPluginContext,
  GraphQLPluginEntry,
  GraphQLSchemaSource,
  NodeHandler,
} from "./graphql-entry";
import { writeGeneratedFiles } from "./write-generated-files";

export type { GraphQLPluginContext, GraphQLPluginEntry } from "./graphql-entry";

type GraphQLEntryModule = {
  readonly default?: unknown;
};

export interface GraphQLCodegenPluginLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  error(error: Error, properties?: Record<string, unknown>): void;
}

export interface GraphQLCodegenPluginOptions extends Omit<GenerateFilesOptions, "schema"> {
  readonly output: string;
  readonly entry: string;
  readonly endpoint?: string | undefined;
  readonly include?: readonly (string | RegExp)[] | undefined;
  readonly logger?: GraphQLCodegenPluginLogger | undefined;
  readonly middleware?: boolean | undefined;
}

export function graphqlCodegenPlugin(options: GraphQLCodegenPluginOptions): Plugin {
  const logger = options.logger ?? noopLogger;
  const endpoint = options.endpoint ?? "/graphql";
  const entryId = options.entry;
  const include = options.include ?? [/\/src\//];
  const enableMiddleware = options.middleware ?? true;

  let config: ResolvedConfig;
  let server: ViteDevServer | undefined;
  let devEntry: Promise<GraphQLPluginEntry> | undefined;
  let handler: Promise<NodeHandler> | undefined;
  let refreshQueue: Promise<void> = Promise.resolve();
  let lastSDL: string | undefined;

  function isIncluded(file: string): boolean {
    const normalized = normalizePath(file);
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

  function devContext(): GraphQLPluginContext {
    if (!server) {
      throw new Error("[graphql-codegen] Vite dev server is not ready.");
    }
    const currentServer = server;

    return {
      async importModule<T = unknown>(id: string): Promise<T> {
        const ssrEnv = currentServer.environments.ssr;
        if (!isRunnableDevEnvironment(ssrEnv)) {
          throw new Error("[graphql-codegen] Vite SSR environment is not runnable.");
        }
        return (await ssrEnv.runner.import(id)) as T;
      },
    };
  }

  async function loadDevSchemaSDL(): Promise<string> {
    const entry = await loadDevEntry(devContext());
    return normalizeSchema(await entry.schema());
  }

  async function loadDevHandler(): Promise<NodeHandler> {
    const context = devContext();
    const entry = await loadDevEntry(context);
    if (!entry.handler) {
      throw new Error(
        "[graphql-codegen] GraphQL middleware requires a default export with handler(). Set middleware: false when using an external GraphQL server.",
      );
    }
    handler ??= Promise.resolve(entry.handler(context));
    return handler;
  }

  async function loadDevEntry(context: GraphQLPluginContext): Promise<GraphQLPluginEntry> {
    devEntry ??= (async () => {
      const mod = await context.importModule<GraphQLEntryModule>(entryId);
      return readGraphQLEntry(mod.default, entryId);
    })();
    return devEntry;
  }

  async function loadBuildEntry(): Promise<GraphQLPluginEntry> {
    const mod = (await import(pathToFileURL(entryPath()).href)) as GraphQLEntryModule;
    return readGraphQLEntry(mod.default, entryId);
  }

  function normalizeSchema(schema: GraphQLSchemaSource): string {
    if (typeof schema === "string") {
      return schema;
    }
    return printSchema(schema);
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

    const files = await generateFiles({
      schema: sdl,
      framework: options.framework,
      adapter: options.adapter,
    });
    const writeStats = await writeGeneratedFiles(files, rootPath(options.output));
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
    const sdl = normalizeSchema(await entry.schema());
    const files = await generateFiles({
      schema: sdl,
      framework: options.framework,
      adapter: options.adapter,
    });
    const writeStats = await writeGeneratedFiles(files, rootPath(options.output));
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

  return {
    name: "vite-plugin-graphql-codegen",
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

      return () => {
        viteServer.middlewares.use(async (req, res, next) => {
          if (!isGraphQLRequest(req.url)) {
            return next();
          }

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
        });
      };
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

const noopLogger: GraphQLCodegenPluginLogger = {
  debug: noop,
  info: noop,
  error: noop,
};

function readGraphQLEntry(value: unknown, source: string): GraphQLPluginEntry {
  if (!isGraphQLEntry(value)) {
    throw new Error(
      `[graphql-codegen] ${source} must default-export an object with schema() and optional handler().`,
    );
  }

  return value;
}

function isGraphQLEntry(value: unknown): value is GraphQLPluginEntry {
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

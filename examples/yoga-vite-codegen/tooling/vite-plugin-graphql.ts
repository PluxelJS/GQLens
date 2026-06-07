import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import { printSchema, type GraphQLSchema } from "graphql";
import { generateFiles, type GenerateFilesOptions } from "../../../packages/codegen/src/index";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { isRunnableDevEnvironment, normalizePath } from "vite";
import { writeGeneratedFiles } from "./write-generated-files";

type MaybePromise<T> = T | Promise<T>;
type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>;

type SchemaEntry = {
  readonly createSchema?: (() => MaybePromise<GraphQLSchema>) | undefined;
  readonly createSchemaSDL?: (() => MaybePromise<string>) | undefined;
  readonly schema?: GraphQLSchema | undefined;
  readonly schemaSDL?: string | undefined;
};

export interface GraphQLCodegenPluginContext {
  readonly server: ViteDevServer;
  importModule<T = unknown>(id: string): Promise<T>;
}

export interface GraphQLCodegenPluginLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  error(error: Error, properties?: Record<string, unknown>): void;
}

export interface GraphQLCodegenPluginOptions extends Omit<GenerateFilesOptions, "schema"> {
  readonly output: string;
  readonly schemaEntry?: string | undefined;
  readonly loadSchemaSDL?:
    | ((context: GraphQLCodegenPluginContext) => MaybePromise<string | GraphQLSchema>)
    | undefined;
  readonly loadBuildSchemaSDL?: (() => MaybePromise<string | GraphQLSchema>) | undefined;
  readonly handlerEntry?: string | undefined;
  readonly handlerExport?: string | readonly string[] | undefined;
  readonly loadHandler?:
    | ((context: GraphQLCodegenPluginContext) => MaybePromise<NodeHandler>)
    | undefined;
  readonly endpoint?: string | undefined;
  readonly include?: readonly (string | RegExp)[] | undefined;
  readonly logger?: GraphQLCodegenPluginLogger | undefined;
  readonly middleware?: boolean | undefined;
}

export function graphqlCodegenPlugin(options: GraphQLCodegenPluginOptions): Plugin {
  const logger = options.logger ?? noopLogger;
  const endpoint = options.endpoint ?? "/graphql";
  const schemaEntry = options.schemaEntry ?? "/src/schema.ts";
  const handlerEntry = options.handlerEntry ?? "/src/yoga.ts";
  const handlerExports = normalizeExports(
    options.handlerExport ?? ["createHandler", "createNodeHandler", "createYogaHandler"],
  );
  const include = options.include ?? [/\/src\//];
  const enableMiddleware = options.middleware ?? true;

  let config: ResolvedConfig;
  let server: ViteDevServer | undefined;
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

  function isGraphQLRequest(url: string | undefined): boolean {
    if (!url) {
      return false;
    }

    const { pathname } = new URL(url, "http://vite.local");
    return pathname === endpoint || pathname.startsWith(`${endpoint}/`);
  }

  function devContext(): GraphQLCodegenPluginContext {
    if (!server) {
      throw new Error("[graphql-codegen] Vite dev server is not ready.");
    }
    const currentServer = server;

    return {
      server: currentServer,
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
    const context = devContext();
    if (options.loadSchemaSDL) {
      return normalizeSchema(await options.loadSchemaSDL(context));
    }

    const mod = await context.importModule<SchemaEntry>(schemaEntry);
    if (typeof mod.createSchemaSDL === "function") {
      return mod.createSchemaSDL();
    }
    if (typeof mod.schemaSDL === "string") {
      return mod.schemaSDL;
    }
    if (typeof mod.createSchema === "function") {
      return normalizeSchema(await mod.createSchema());
    }
    if (mod.schema) {
      return normalizeSchema(mod.schema);
    }

    throw new Error(
      `[graphql-codegen] ${schemaEntry} must export createSchemaSDL(), schemaSDL, createSchema(), or schema, or pass loadSchemaSDL().`,
    );
  }

  async function loadHandler(): Promise<NodeHandler> {
    const context = devContext();
    if (options.loadHandler) {
      handler ??= Promise.resolve(options.loadHandler(context));
      return handler;
    }

    handler ??= (async () => {
      const mod = await context.importModule<Record<string, unknown>>(handlerEntry);
      const factory = handlerExports
        .map((name) => mod[name])
        .find((value) => typeof value === "function");
      if (!factory) {
        throw new Error(
          `[graphql-codegen] ${handlerEntry} must export one of: ${handlerExports.join(", ")}.`,
        );
      }

      return (factory as () => MaybePromise<NodeHandler>)();
    })();

    return handler;
  }

  function normalizeSchema(schema: string | GraphQLSchema): string {
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
        schemaEntry,
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
      schemaEntry,
      output: options.output,
      durationMs: Math.round(performance.now() - startedAt),
      files: writeStats.total,
      changed: writeStats.changed,
      skipped: writeStats.skipped,
    });
  }

  async function generateBuildFiles(): Promise<void> {
    if (!options.loadBuildSchemaSDL) {
      return;
    }

    const startedAt = performance.now();
    const sdl = normalizeSchema(await options.loadBuildSchemaSDL());
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
            const currentHandler = await loadHandler();
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
      logger.debug("GraphQL-related module changed; refreshing handler and generated files.", {
        file: normalizePath(ctx.file),
      });
      await enqueueRefresh(false);
      return ctx.modules;
    },
  };
}

function normalizeExports(value: string | readonly string[]): readonly string[] {
  return typeof value === "string" ? [value] : value;
}

const noopLogger: GraphQLCodegenPluginLogger = {
  debug: noop,
  info: noop,
  error: noop,
};

function noop(): void {
  return undefined;
}

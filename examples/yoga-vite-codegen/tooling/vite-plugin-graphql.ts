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
};

export interface GraphQLCodegenPluginOptions extends Omit<GenerateFilesOptions, "schema"> {
  readonly output: string;
  readonly schemaEntry?: string | undefined;
  readonly handlerEntry?: string | undefined;
  readonly handlerExport?: string | readonly string[] | undefined;
  readonly endpoint?: string | undefined;
  readonly include?: readonly (string | RegExp)[] | undefined;
  readonly middleware?: boolean | undefined;
}

export function graphqlCodegenPlugin(options: GraphQLCodegenPluginOptions): Plugin {
  const endpoint = options.endpoint ?? "/graphql";
  const schemaEntry = options.schemaEntry ?? "/src/graphql/schema.ts";
  const handlerEntry = options.handlerEntry ?? "/src/graphql/yoga.ts";
  const handlerExports = normalizeExports(
    options.handlerExport ?? ["createHandler", "createNodeHandler", "createYogaHandler"],
  );
  const include = options.include ?? [
    /\/src\/graphql\//,
    /\/src\/services\//,
    /\/src\/server-runtime\//,
  ];
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

  function isGraphQLRequest(url: string | undefined): boolean {
    if (!url) {
      return false;
    }

    const { pathname } = new URL(url, "http://vite.local");
    return pathname === endpoint || pathname.startsWith(`${endpoint}/`);
  }

  function rootPath(value: string): string {
    return isAbsolute(value) ? value : join(config.root, value);
  }

  async function loadDevSchemaSDL(): Promise<string> {
    if (!server) {
      throw new Error("[graphql-codegen] Vite dev server is not ready.");
    }

    const ssrEnv = server.environments.ssr;
    if (!isRunnableDevEnvironment(ssrEnv)) {
      throw new Error("[graphql-codegen] Vite SSR environment is not runnable.");
    }

    const mod = (await ssrEnv.runner.import(schemaEntry)) as SchemaEntry;
    if (typeof mod.createSchemaSDL === "function") {
      return mod.createSchemaSDL();
    }
    if (typeof mod.createSchema === "function") {
      return printSchema(await mod.createSchema());
    }

    throw new Error(`[graphql-codegen] ${schemaEntry} must export createSchema().`);
  }

  async function loadHandler(): Promise<NodeHandler> {
    if (!server) {
      throw new Error("[graphql-codegen] Vite dev server is not ready.");
    }

    handler ??= (async () => {
      const ssrEnv = server.environments.ssr;
      if (!isRunnableDevEnvironment(ssrEnv)) {
        throw new Error("[graphql-codegen] Vite SSR environment is not runnable.");
      }

      const mod = (await ssrEnv.runner.import(handlerEntry)) as Record<string, unknown>;
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

  async function refreshGeneratedFiles(force: boolean): Promise<void> {
    const sdl = await loadDevSchemaSDL();
    const schemaChanged = lastSDL !== sdl;
    lastSDL = sdl;

    if (!force && !schemaChanged) {
      return;
    }

    const files = await generateFiles({
      schema: sdl,
      framework: options.framework,
      adapter: options.adapter,
    });
    await writeGeneratedFiles(files, rootPath(options.output));
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
    apply: "serve",
    enforce: "pre",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    async configureServer(viteServer) {
      server = viteServer;
      await enqueueRefresh(true);

      if (!enableMiddleware) {
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
      await enqueueRefresh(false);
      return ctx.modules;
    },
  };
}

function normalizeExports(value: string | readonly string[]): readonly string[] {
  return typeof value === "string" ? [value] : value;
}

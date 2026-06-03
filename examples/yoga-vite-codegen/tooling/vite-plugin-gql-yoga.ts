import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";
import { isRunnableDevEnvironment, normalizePath } from "vite";

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>;

type GqlYogaDevEntry = {
  createNodeHandler: () => NodeHandler | Promise<NodeHandler>;
};

export interface GqlYogaDevPluginOptions {
  readonly endpoint?: string | undefined;
  readonly entry?: string | undefined;
  readonly include?: readonly (string | RegExp)[] | undefined;
}

export function gqlYogaDevPlugin(options: GqlYogaDevPluginOptions = {}): Plugin {
  const endpoint = options.endpoint ?? "/graphql";
  const entry = options.entry ?? "/src/graphql/dev-entry.ts";

  const include = options.include ?? [
    /\/src\/graphql\//,
    /\/src\/services\//,
    /\/src\/server-runtime\//,
  ];

  let server: ViteDevServer;
  let cachedHandler: Promise<NodeHandler> | undefined;

  function isGraphQLRelatedFile(file: string): boolean {
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

  async function loadHandler(): Promise<NodeHandler> {
    cachedHandler ??= (async () => {
      const ssrEnv = server.environments.ssr;

      if (!isRunnableDevEnvironment(ssrEnv)) {
        throw new Error(
          "[gql-yoga-dev] Vite SSR environment is not runnable. Use the default Node SSR environment.",
        );
      }

      const mod = (await ssrEnv.runner.import(entry)) as GqlYogaDevEntry;

      if (typeof mod.createNodeHandler !== "function") {
        throw new Error(`[gql-yoga-dev] ${entry} must export createNodeHandler().`);
      }

      return mod.createNodeHandler();
    })();

    return cachedHandler;
  }

  function invalidateGraphQLRuntime(file?: string): void {
    cachedHandler = undefined;

    server.ws.send({
      type: "custom",
      event: "gql-yoga:invalidate",
      data: {
        file,
        endpoint,
        timestamp: Date.now(),
      },
    });
  }

  return {
    name: "vite-plugin-gql-yoga-dev",
    apply: "serve",
    enforce: "pre",

    configureServer(viteServer) {
      server = viteServer;

      return () => {
        server.middlewares.use(async (req, res, next) => {
          if (!isGraphQLRequest(req.url)) {
            return next();
          }

          try {
            const handler = await loadHandler();
            await handler(req, res);
          } catch (error) {
            cachedHandler = undefined;
            next(error);
          }
        });
      };
    },

    handleHotUpdate(ctx) {
      if (!isGraphQLRelatedFile(ctx.file)) {
        return;
      }

      invalidateGraphQLRuntime(normalizePath(ctx.file));
      return ctx.modules;
    },
  };
}

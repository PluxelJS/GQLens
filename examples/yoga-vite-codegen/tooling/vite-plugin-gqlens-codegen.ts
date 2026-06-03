import type { GraphQLSchema } from "graphql";
import { printSchema } from "graphql";
import type { Plugin, ViteDevServer } from "vite";
import { isRunnableDevEnvironment, normalizePath } from "vite";
import { gqlensRolldown, type GQLensRolldownOptions } from "@gqlens/codegen/rolldown";

type CodegenEntry = {
  readonly createSchema?: (() => GraphQLSchema | Promise<GraphQLSchema>) | undefined;
  readonly createSchemaSDL?: (() => string | Promise<string>) | undefined;
};

export interface GQLensCodegenDevPluginOptions extends Omit<GQLensRolldownOptions, "schema"> {
  readonly entry?: string | undefined;
  readonly include?: readonly (string | RegExp)[] | undefined;
}

export function gqlensCodegenDevPlugin(options: GQLensCodegenDevPluginOptions): Plugin {
  const entry = options.entry ?? "/src/graphql/codegen-entry.ts";
  const include = options.include ?? [
    /\/src\/graphql\//,
    /\/src\/services\//,
    /\/src\/server-runtime\//,
  ];

  let server: ViteDevServer | undefined;
  let regenerateQueue: Promise<void> = Promise.resolve();

  const codegen = gqlensRolldown({
    ...options,
    schema: async () => {
      if (!server) {
        throw new Error("[gqlens-codegen-dev] Vite dev server is not ready.");
      }

      const ssrEnv = server.environments.ssr;
      if (!isRunnableDevEnvironment(ssrEnv)) {
        throw new Error(
          "[gqlens-codegen-dev] Vite SSR environment is not runnable. Use the default Node SSR environment.",
        );
      }

      const mod = (await ssrEnv.runner.import(entry)) as CodegenEntry;
      if (typeof mod.createSchemaSDL === "function") {
        return mod.createSchemaSDL();
      }
      if (typeof mod.createSchema === "function") {
        return printSchema(await mod.createSchema());
      }

      throw new Error(
        `[gqlens-codegen-dev] ${entry} must export createSchema() or createSchemaSDL().`,
      );
    },
  });

  function isGraphQLRelatedFile(file: string): boolean {
    const normalized = normalizePath(file);
    return include.some((rule) =>
      typeof rule === "string" ? normalized.includes(rule) : rule.test(normalized),
    );
  }

  async function regenerate(file?: string): Promise<void> {
    await codegen.buildStart.call({
      addWatchFile(id) {
        server?.watcher.add(id);
      },
      error(error): never {
        throw error instanceof Error ? error : new Error(error);
      },
    });

    server?.ws.send({
      type: "custom",
      event: "gqlens:codegen",
      data: {
        file,
        output: options.output,
        timestamp: Date.now(),
      },
    });
  }

  function enqueueRegenerate(file?: string): Promise<void> {
    regenerateQueue = regenerateQueue.then(
      () => regenerate(file),
      () => regenerate(file),
    );
    return regenerateQueue;
  }

  return {
    name: "vite-plugin-gqlens-codegen-dev",
    apply: "serve",
    enforce: "pre",

    async configureServer(viteServer) {
      server = viteServer;
      await enqueueRegenerate();
    },

    async handleHotUpdate(ctx) {
      if (!isGraphQLRelatedFile(ctx.file)) {
        return;
      }

      await enqueueRegenerate(normalizePath(ctx.file));
      return ctx.modules;
    },
  };
}

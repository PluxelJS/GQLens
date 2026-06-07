import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { generateFiles } from "../../packages/codegen/src/index";

import { configureExampleLogging, getExampleLogger } from "./src/logging";
import { createSchemaSDL } from "./src/schema";
import { graphqlCodegenPlugin } from "./tooling/vite-plugin-graphql";
import { writeGeneratedFiles } from "./tooling/write-generated-files";

configureExampleLogging();

const logger = getExampleLogger("build");
const viteLogger = getExampleLogger("vite");
const graphQLRelatedFiles = [/\/src\//] as const;

const graphQLEndpoint = "/graphql";
const graphQLProxyTarget = process.env.GRAPHQL_PROXY_TARGET;
const graphQLPackageRoot = fileURLToPath(new URL("node_modules/graphql", import.meta.url));

const gqlensBuildCodegenPlugin = {
  name: "gqlens-build-codegen",
  apply: "build",
  async buildStart() {
    const startedAt = performance.now();
    const files = await generateFiles({
      schema: createSchemaSDL(),
      framework: "react",
    });
    const writeStats = await writeGeneratedFiles(files, "web/gqlens");
    logger.info("Generated GQLens files for build in {durationMs}ms.", {
      durationMs: Math.round(performance.now() - startedAt),
      output: "web/gqlens",
      files: writeStats.total,
      changed: writeStats.changed,
      skipped: writeStats.skipped,
    });
  },
} satisfies Plugin;

export default defineConfig({
  appType: "spa",

  plugins: [
    graphqlCodegenPlugin({
      output: "web/gqlens",
      schemaEntry: "/src/schema.ts",
      handlerEntry: "/src/yoga.ts",
      endpoint: graphQLEndpoint,
      include: graphQLRelatedFiles,
      framework: "react",
      logger: viteLogger,
      middleware: !graphQLProxyTarget,
    }),

    gqlensBuildCodegenPlugin,

    react(),
  ],

  ...(graphQLProxyTarget
    ? {
        server: {
          proxy: {
            [graphQLEndpoint]: {
              target: graphQLProxyTarget,
              changeOrigin: true,
            },
          },
        },
      }
    : {}),

  ssr: {},

  resolve: {
    alias: [
      { find: /^graphql$/, replacement: `${graphQLPackageRoot}/index.mjs` },
      { find: /^graphql\/(.+)$/, replacement: `${graphQLPackageRoot}/$1` },
      {
        find: "@gqlens/core/codegen",
        replacement: fileURLToPath(
          new URL("../../packages/core/codegen/index.ts", import.meta.url),
        ),
      },
      {
        find: "@gqlens/core",
        replacement: fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      },
      {
        find: "@gqlens/react",
        replacement: fileURLToPath(new URL("../../packages/react/src/index.tsx", import.meta.url)),
      },
    ],
  },

  optimizeDeps: {
    exclude: ["graphql", "graphql-yoga"],
  },
});

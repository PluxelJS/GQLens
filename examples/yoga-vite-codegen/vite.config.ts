import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { configureExampleLogging, getExampleLogger } from "./src/logging";
import { createSchemaSDL } from "./src/schema";
import { graphqlCodegenPlugin } from "./tooling/vite-plugin-graphql";

configureExampleLogging();

const viteLogger = getExampleLogger("vite");
const graphQLRelatedFiles = [/\/src\//] as const;

const graphQLEndpoint = "/graphql";
const graphQLProxyTarget = process.env.GRAPHQL_PROXY_TARGET;
const graphQLPackageRoot = fileURLToPath(new URL("node_modules/graphql", import.meta.url));

export default defineConfig({
  appType: "spa",

  plugins: [
    graphqlCodegenPlugin({
      output: "web/gqlens",
      schemaEntry: "/src/schema.ts",
      loadBuildSchemaSDL: createSchemaSDL,
      handlerEntry: "/src/yoga.ts",
      endpoint: graphQLEndpoint,
      include: graphQLRelatedFiles,
      framework: "react",
      logger: viteLogger,
      middleware: !graphQLProxyTarget,
    }),

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

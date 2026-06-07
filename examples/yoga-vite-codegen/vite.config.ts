import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { gqlens } from "@gqlens/vite";
import { configureExampleLogging, getExampleLogger } from "./src/logging";

configureExampleLogging();

const viteLogger = getExampleLogger("vite");
const graphQLRelatedFiles = [/\/src\//] as const;

const graphQLEndpoint = "/graphql";
const graphQLProxyTarget = process.env.GRAPHQL_PROXY_TARGET;
const graphQLPackageRoot = fileURLToPath(new URL("node_modules/graphql", import.meta.url));

export default defineConfig({
  appType: "spa",

  plugins: [
    gqlens({
      output: "web/gqlens",
      entry: "/src/graphql-entry.ts",
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

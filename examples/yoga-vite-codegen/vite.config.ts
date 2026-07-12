import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { gqlens } from "@gqlens/vite";
import { configureExampleLogging, getExampleLogger } from "./src/logging";

configureExampleLogging();

const viteLogger = getExampleLogger("vite");
const graphQLRelatedFiles = [/\/src\//] as const;

const graphQLEndpoint = "/graphql";
const graphQLProxyTarget = process.env.GRAPHQL_PROXY_TARGET;

export default defineConfig({
  appType: "spa",

  resolve: {
    conditions: ["module", "browser"],
  },

  ssr: {
    resolve: {
      conditions: ["module", "node"],
    },
  },

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
});

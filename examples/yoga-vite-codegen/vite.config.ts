import react from "@vitejs/plugin-react";
import { printSchema } from "graphql";
import { defineConfig, type Plugin } from "vite";
import { gqlensRolldown } from "@gqlens/codegen/rolldown";

import { createSchema } from "./src/graphql/schema";
import { gqlensCodegenDevPlugin } from "./tooling/vite-plugin-gqlens-codegen";
import { gqlYogaDevPlugin } from "./tooling/vite-plugin-gql-yoga";

const graphQLRelatedFiles = [
  /\/src\/graphql\//,
  /\/src\/services\//,
  /\/src\/server-runtime\//,
] as const;

const graphQLEndpoint = "/graphql";
const graphQLProxyTarget = process.env.GRAPHQL_PROXY_TARGET;

const gqlensBuildCodegenPlugin = {
  ...gqlensRolldown({
    output: "src/gqlens",
    schema: () => printSchema(createSchema()),
    framework: "react",
    watch: graphQLRelatedFiles,
  }),
  apply: "build",
} satisfies Plugin;

export default defineConfig({
  appType: "spa",

  plugins: [
    gqlensCodegenDevPlugin({
      output: "src/gqlens",
      entry: "/src/graphql/codegen-entry.ts",
      include: graphQLRelatedFiles,
      framework: "react",
    }),

    ...(graphQLProxyTarget
      ? []
      : [
          gqlYogaDevPlugin({
            endpoint: graphQLEndpoint,
            entry: "/src/graphql/dev-entry.ts",
            include: graphQLRelatedFiles,
          }),
        ]),

    gqlensBuildCodegenPlugin,

    react(),
  ],

  server: graphQLProxyTarget
    ? {
        proxy: {
          [graphQLEndpoint]: {
            target: graphQLProxyTarget,
            changeOrigin: true,
          },
        },
      }
    : undefined,

  ssr: {
    noExternal: ["graphql", "graphql-yoga"],
  },

  optimizeDeps: {
    exclude: ["graphql", "graphql-yoga"],
  },
});

import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { generateFiles } from "../../packages/codegen/src/index";

import { createSchemaSDL } from "./src/graphql/schema";
import { graphqlCodegenPlugin } from "./tooling/vite-plugin-graphql";
import { writeGeneratedFiles } from "./tooling/write-generated-files";

const graphQLRelatedFiles = [
  /\/src\/graphql\//,
  /\/src\/services\//,
  /\/src\/server-runtime\//,
] as const;

const graphQLEndpoint = "/graphql";
const graphQLProxyTarget = process.env.GRAPHQL_PROXY_TARGET;
const graphQLPackageRoot = fileURLToPath(new URL("node_modules/graphql", import.meta.url));

const gqlensBuildCodegenPlugin = {
  name: "gqlens-build-codegen",
  apply: "build",
  async buildStart() {
    const files = await generateFiles({
      schema: createSchemaSDL(),
      framework: "react",
    });
    await writeGeneratedFiles(files, "src/gqlens");
  },
} satisfies Plugin;

export default defineConfig({
  appType: "spa",

  plugins: [
    graphqlCodegenPlugin({
      output: "src/gqlens",
      schemaEntry: "/src/graphql/schema.ts",
      handlerEntry: "/src/graphql/yoga.ts",
      endpoint: graphQLEndpoint,
      include: graphQLRelatedFiles,
      framework: "react",
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

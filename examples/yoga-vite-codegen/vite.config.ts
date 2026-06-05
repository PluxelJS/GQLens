import react from "@vitejs/plugin-react";
import { printSchema } from "graphql";
import { defineConfig, type Plugin } from "vite";
import { generateFiles } from "@gqlens/codegen";

import { createSchema } from "./src/graphql/schema";
import { graphqlCodegenPlugin } from "./tooling/vite-plugin-graphql";
import { writeGeneratedFiles } from "./tooling/write-generated-files";

const graphQLRelatedFiles = [
  /\/src\/graphql\//,
  /\/src\/services\//,
  /\/src\/server-runtime\//,
] as const;

const graphQLEndpoint = "/graphql";
const graphQLProxyTarget = process.env.GRAPHQL_PROXY_TARGET;

const gqlensBuildCodegenPlugin = {
  name: "gqlens-build-codegen",
  apply: "build",
  async buildStart() {
    const files = await generateFiles({
      schema: printSchema(createSchema()),
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

  ssr: {
    noExternal: ["graphql", "graphql-yoga"],
  },

  optimizeDeps: {
    exclude: ["graphql", "graphql-yoga"],
  },
});

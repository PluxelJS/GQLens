import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

import { configureExampleLogging, getExampleLogger } from "./src/logging.ts";

configureExampleLogging();

const viteLogger = getExampleLogger("vite");
const graphQLRelatedFiles = [/\/src\//] as const;

const graphQLEndpoint = "/graphql";
const graphQLProxyTarget = process.env.GRAPHQL_PROXY_TARGET;

export default defineConfig({
  lint: {
    options: { reportUnusedDisableDirectives: "error" },
    ignorePatterns: ["web/gqlens/**", "dist/**", "node_modules/**", ".vite/**"],
  },
  appType: "spa",

  resolve: {
    conditions: ["module", "browser"],
  },

  ssr: {
    resolve: {
      conditions: ["module", "node"],
    },
  },

  plugins:
    lazyPlugins(async () => {
      // Resolve only when plugins run; metadata checks also work before packages build.
      const { gqlens } = (await import(
        import.meta.resolve("@gqlens/vite")
      )) as typeof import("@gqlens/vite");
      return [
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
      ];
    }) ?? [],

  server: {
    host: process.env.HOST ?? "127.0.0.1",
    port: process.env.PORT === undefined ? 5173 : Number(process.env.PORT),
    strictPort: process.env.PORT !== undefined,
    ...(graphQLProxyTarget
      ? { proxy: { [graphQLEndpoint]: { target: graphQLProxyTarget, changeOrigin: true } } }
      : {}),
  },
  run: {
    tasks: {
      serve: {
        command: "vp dev",
        dependsOn: ["@gqlens/vite#compile", "@gqlens/react#compile"],
        cache: false,
      },
      "serve-backend": {
        command: "tsx src/server.ts",
        cache: false,
      },
      "check-tools": {
        command: "vp fmt --check && vp lint --config vite.config.ts",
        cache: false,
      },
      generate: {
        command: "tsx tooling/generate-gqlens.ts",
        dependsOn: ["@gqlens/vite#compile"],
        cache: {
          input: [
            { auto: true },
            { pattern: "!**/node_modules/.vite/**", base: "workspace" },
            { pattern: "!**/node_modules/.vitest-cache/**", base: "workspace" },
            "src/**",
            "tooling/**",
          ],
          output: ["web/gqlens/*.ts", "web/gqlens/.gqlens-meta.json"],
        },
      },
      compile: {
        command: "vp build",
        dependsOn: ["generate", "@gqlens/react#compile"],
        cache: {
          input: [
            { auto: true },
            { pattern: "!**/node_modules/.vite/**", base: "workspace" },
            { pattern: "!**/node_modules/.vitest-cache/**", base: "workspace" },
            "src/**",
            "web/client/**",
          ],
          output: ["dist/**"],
          env: ["GRAPHQL_PROXY_TARGET"],
        },
      },
      "check-types": {
        command: "tsc --noEmit",
        dependsOn: ["generate", "@gqlens/react#compile"],
        cache: {
          input: [
            { auto: true },
            { pattern: "!**/node_modules/.vite/**", base: "workspace" },
            { pattern: "!**/node_modules/.vitest-cache/**", base: "workspace" },
          ],
          output: [],
        },
      },
      "check-tests": {
        command: "tsx test/frontend-contract.ts && tsx test/smoke.ts",
        dependsOn: ["generate", "@gqlens/react#compile"],
        cache: {
          input: [
            { auto: true },
            { pattern: "!**/node_modules/.vite/**", base: "workspace" },
            { pattern: "!**/node_modules/.vitest-cache/**", base: "workspace" },
          ],
          output: [],
        },
      },
      "example:verify": {
        command: [],
        dependsOn: ["check-tools", "check-types", "check-tests", "compile"],
        cache: false,
      },
    },
  },
});

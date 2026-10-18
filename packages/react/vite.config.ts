import { defineConfig } from "vite-plus";

const config: ReturnType<typeof defineConfig> = defineConfig({
  pack: {
    minify: true,
    entry: {
      index: "src/index.tsx",
    },
    outDir: "dist",
    format: "esm",
    platform: "neutral",
    target: "esnext",
    clean: true,
    dts: true,
    sourcemap: true,
    shims: false,
    deps: {
      neverBundle: ["react", "@gqlens/core"],
    },
    exports: {
      devExports: "development",
    },
  },
  run: {
    tasks: {
      compile: {
        command: "vp pack",
        dependsOn: ["@gqlens/core#compile"],
        cache: {
          input: [
            { auto: true },
            { pattern: "!**/node_modules/.vite/**", base: "workspace" },
            { pattern: "!**/node_modules/.vitest-cache/**", base: "workspace" },
            { pattern: "../../tsconfig.json", base: "package" },
            { pattern: "../core/src/**", base: "package" },
            { pattern: "../core/codegen/**", base: "package" },
          ],
          output: ["dist/**"],
        },
      },
      "check-tests": {
        command: "vp test run --maxWorkers=2 --config vitest.config.mts",
        dependsOn: ["@gqlens/core#compile"],
        cache: {
          input: [
            { auto: true },
            { pattern: "!**/node_modules/.vite/**", base: "workspace" },
            { pattern: "!**/node_modules/.vitest-cache/**", base: "workspace" },
            { pattern: "../../tsconfig.json", base: "package" },
            { pattern: "../core/src/**", base: "package" },
            { pattern: "../core/codegen/**", base: "package" },
          ],
          output: [],
        },
      },
      "check-types": {
        command: "tsc --noEmit",
        dependsOn: ["@gqlens/core#compile"],
        cache: {
          input: [
            { auto: true },
            { pattern: "!**/node_modules/.vite/**", base: "workspace" },
            { pattern: "!**/node_modules/.vitest-cache/**", base: "workspace" },
            { pattern: "../../tsconfig.json", base: "package" },
            { pattern: "../core/src/**", base: "package" },
            { pattern: "../core/codegen/**", base: "package" },
          ],
          output: [],
        },
      },
    },
  },
});

export default config;

import { defineConfig } from "vite-plus";

const config: ReturnType<typeof defineConfig> = defineConfig({
  pack: {
    minify: true,
    entry: {
      index: "src/index.ts",
      codegen: "codegen/index.ts",
      oxlint: "oxlint/index.ts",
    },
    outDir: "dist",
    format: "esm",
    platform: "neutral",
    clean: true,
    dts: true,
    sourcemap: true,
    shims: false,
    exports: {
      devExports: "development",
    },
  },
  run: {
    tasks: {
      compile: {
        command: "vp pack",
        dependsOn: [],
        cache: {
          input: [
            { auto: true },
            { pattern: "!**/node_modules/.vite/**", base: "workspace" },
            { pattern: "!**/node_modules/.vitest-cache/**", base: "workspace" },
            { pattern: "../../tsconfig.json", base: "package" },
          ],
          output: ["dist/**"],
        },
      },
      "check-tests": {
        command: "vp test run --maxWorkers=2 --config vitest.config.mts",
        dependsOn: [],
        cache: {
          input: [
            { auto: true },
            { pattern: "!**/node_modules/.vite/**", base: "workspace" },
            { pattern: "!**/node_modules/.vitest-cache/**", base: "workspace" },
            { pattern: "../../tsconfig.json", base: "package" },
          ],
          output: [],
        },
      },
      "check-types": {
        command: "tsc --noEmit",
        dependsOn: [],
        cache: {
          input: [
            { auto: true },
            { pattern: "!**/node_modules/.vite/**", base: "workspace" },
            { pattern: "!**/node_modules/.vitest-cache/**", base: "workspace" },
            { pattern: "../../tsconfig.json", base: "package" },
          ],
          output: [],
        },
      },
    },
  },
});

export default config;

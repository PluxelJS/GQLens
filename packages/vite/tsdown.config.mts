import { defineConfig } from "tsdown";

const config: ReturnType<typeof defineConfig> = defineConfig({
  minify: true,
  entry: { index: "src/index.ts", entry: "src/entry.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node24.12.0",
  clean: true,
  dts: true,
  sourcemap: true,
  shims: false,
  deps: {
    neverBundle: ["@gqlens/codegen", "vite", "graphql"],
  },
  exports: {
    devExports: "development",
  },
});

export default config;

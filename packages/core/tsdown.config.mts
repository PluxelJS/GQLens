import { defineConfig } from "tsdown";

const config: ReturnType<typeof defineConfig> = defineConfig({
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
});

export default config;

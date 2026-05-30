import { defineConfig } from "tsdown";

const config: ReturnType<typeof defineConfig> = defineConfig({
  entry: {
    index: "src/index.ts",
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
    neverBundle: ["solid-js", "@gqlens/core"],
  },
  exports: {
    devExports: "development",
  },
});

export default config;

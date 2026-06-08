import { defineConfig } from "tsdown";

const config: ReturnType<typeof defineConfig> = defineConfig({
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
});

export default config;

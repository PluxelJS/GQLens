import { defineConfig } from "tsdown";

const config: ReturnType<typeof defineConfig> = defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node24",
  clean: true,
  dts: true,
  sourcemap: true,
  shims: false,
});

export default config;

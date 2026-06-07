import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const config: ReturnType<typeof defineConfig> = defineConfig({
  test: {
    pool: "forks",
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@gqlens/codegen": fileURLToPath(new URL("../codegen/src/index.ts", import.meta.url)),
    },
  },
});

export default config;

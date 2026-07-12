import { defineConfig } from "vitest/config";

const config: ReturnType<typeof defineConfig> = defineConfig({
  test: {
    pool: "forks",
    testTimeout: 30_000,
  },
  resolve: {
    conditions: ["development"],
  },
});

export default config;

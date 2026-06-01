import { defineConfig } from "vitest/config";

const config: ReturnType<typeof defineConfig> = defineConfig({
  root: new URL(".", import.meta.url).pathname,
  resolve: {
    conditions: ["development"],
    alias: {
      "@gqlens/core": new URL("../core/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "jsdom",
  },
});

export default config;

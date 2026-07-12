import { defineConfig } from "vitest/config";

const config: ReturnType<typeof defineConfig> = defineConfig({
  root: new URL(".", import.meta.url).pathname,
  resolve: {
    conditions: ["development"],
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});

export default config;

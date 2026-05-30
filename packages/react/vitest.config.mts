import { defineConfig } from "vitest/config";

const config: ReturnType<typeof defineConfig> = defineConfig({
  resolve: {
    conditions: ["development"],
  },
});

export default config;

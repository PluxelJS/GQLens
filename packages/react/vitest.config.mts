import { defineConfig } from "vite-plus";

const config: ReturnType<typeof defineConfig> = defineConfig({
  root: new URL(".", import.meta.url).pathname,
  resolve: {
    conditions: ["development"],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "jsdom",
  },
});

export default config;

import { defineConfig } from "pncat";

export default defineConfig({
  exclude: ["peerDependencies"],
  catalogRules: [
    {
      name: "frontend",
      match: ["react", "react-dom", "@types/react", "@types/react-dom", "@vitejs/plugin-react"],
    },
    { name: "example", match: ["@elysiajs/node", "@logtape/logtape", "elysia", "graphql-yoga"] },
    {
      name: "backend",
      match: ["graphql"],
      specifierRules: [{ specifier: "^16", name: "example" }],
    },
    { name: "test", match: ["vitest", "jsdom", "@testing-library/react"] },
    {
      name: "tooling",
      match: [/^@types\//, "@changesets/cli", "vite", "vite-plus", "typescript", "pncat", "tsx"],
    },
    { name: "backend", match: [/.*/] },
  ],
});

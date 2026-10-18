import { defineConfig } from "pncat";

export default defineConfig({
  saveExact: false,
  depFields: { peerDependencies: false },
  catalogRules: [
    { name: "build", match: ["vite-plus"] },
    { name: "dev", match: ["jsdom"] },
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
    { name: "test", match: ["vitest", "@testing-library/react"] },
    {
      name: "tooling",
      match: [/^@types\//, "@changesets/cli", "vite", "typescript", "pncat", "tsx"],
    },
    { name: "backend", match: [/.*/] },
  ],
});

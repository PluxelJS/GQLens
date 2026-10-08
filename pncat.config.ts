import { defineConfig } from "pncat";

export default defineConfig({
  saveExact: false,
  depFields: { peerDependencies: false },
  catalogRules: [
    {
      name: "frontend",
      match: ["react", "react-dom", "@types/react", "@types/react-dom"],
      priority: 10,
    },
    { name: "backend", match: ["graphql"], priority: 20 },
    { name: "test", match: ["vitest"], priority: 30 },
    { name: "dev", match: ["@testing-library/react", "jsdom"], priority: 40 },
    {
      name: "tooling",
      match: [
        "@changesets/cli",
        "@types/node",
        "oxfmt",
        "oxlint",
        "pncat",
        "tsdown",
        "turbo",
        "typescript",
        "vite",
      ],
      priority: 50,
    },
  ],
});

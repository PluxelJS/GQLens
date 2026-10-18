import { defineConfig } from "vite-plus";
import fmt from "./oxfmt.config.ts";
import lint from "./oxlint.config.ts";

export default defineConfig({
  fmt,
  lint,
  run: {
    cache: { scripts: false, tasks: true },
    tasks: {
      "workspace:build": {
        command: [],
        dependsOn: [
          "@gqlens/core#compile",
          "@gqlens/codegen#compile",
          "@gqlens/react#compile",
          "@gqlens/solid#compile",
          "@gqlens/vite#compile",
        ],
      },
      "workspace:test": {
        command: [],
        dependsOn: [
          "@gqlens/core#check-tests",
          "@gqlens/codegen#check-tests",
          "@gqlens/react#check-tests",
          "@gqlens/solid#check-tests",
          "@gqlens/vite#check-tests",
        ],
      },
      "workspace:types": {
        command: [],
        dependsOn: [
          "@gqlens/core#check-types",
          "@gqlens/codegen#check-types",
          "@gqlens/react#check-types",
          "@gqlens/solid#check-types",
          "@gqlens/vite#check-types",
        ],
      },
      "release-check": {
        command: "node scripts/check-release-invariants.mjs",
        cache: false,
      },
      "source-declarations:check": {
        command: "node scripts/check-source-declarations.mjs",
        cache: false,
      },
      "verify-checks": {
        command: "vp check",
        cache: false,
      },
      "workspace:verify": {
        command: [],
        cache: false,
        dependsOn: [
          "release-check",
          "source-declarations:check",
          "verify-checks",
          "workspace:build",
          "workspace:test",
          "workspace:types",
          "gqlens-yoga-vite-codegen-example#example:verify",
        ],
      },
      "release-smoke": {
        command: "node scripts/smoke-packages.mjs",
        dependsOn: ["workspace:build"],
        cache: false,
      },
      "release-publish": {
        command: "changeset publish",
        dependsOn: ["workspace:verify", "release-smoke"],
        cache: false,
      },
    },
  },
});

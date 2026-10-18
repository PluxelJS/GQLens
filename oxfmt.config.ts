import type { OxfmtConfig } from "vite-plus/fmt";

const fmt: OxfmtConfig = {
  ignorePatterns: [
    ".git/**",
    ".vite/**",
    "dist/**",
    "packages/*/dist/**",
    "packages/codegen/test/fixtures/**/accessor.ts",
    "packages/codegen/test/fixtures/**/invalidation.ts",
    "packages/codegen/test/fixtures/**/normalizer.ts",
    "packages/codegen/test/fixtures/**/types.ts",
    "node_modules/**",
    "out/**",
    "coverage/**",
    "examples/yoga-vite-codegen/web/gqlens/*.ts",
  ],
};

export default fmt;

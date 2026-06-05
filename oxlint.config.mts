import { defineConfig } from "oxlint";

const config: ReturnType<typeof defineConfig> = defineConfig({
  plugins: ["typescript", "unicorn", "oxc", "import", "promise", "node", "vitest"],
  jsPlugins: ["./packages/oxlint-plugin/src/index.ts"],
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "error",
  },
  rules: {
    curly: "error",
    eqeqeq: "error",
    "logical-assignment-operators": "error",
    "no-console": "error",
    "no-duplicate-imports": "error",
    "no-empty-function": "error",
    "no-shadow": "error",
    "no-template-curly-in-string": "error",
    "no-useless-return": "error",
    "no-var": "error",
    "object-shorthand": "error",
    "prefer-const": "error",
    "prefer-object-spread": "error",
    "prefer-template": "error",
    radix: "error",

    "import/first": "error",
    "import/no-cycle": "error",
    "import/no-duplicates": "error",
    "import/no-mutable-exports": "error",
    "import/no-self-import": "error",
    "import/no-unassigned-import": "error",

    "node/no-path-concat": "error",

    "promise/no-multiple-resolved": "error",
    "promise/no-new-statics": "error",
    "promise/no-return-wrap": "error",
    "promise/param-names": "error",

    "gqlens/no-accessor-escape": "error",
    "gqlens/no-untracked-read": "error",
    "gqlens/no-accessor-object-ops": "error",
    "gqlens/selector-pure": "error",
    "gqlens/plain-args": "error",

    "typescript/consistent-type-exports": "error",
    "typescript/consistent-type-imports": "error",
    "typescript/no-empty-object-type": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-import-type-side-effects": "error",
    "typescript/no-require-imports": "error",
    "typescript/no-unsafe-function-type": "error",
    "typescript/no-var-requires": "error",
    "typescript/switch-exhaustiveness-check": "error",

    "vitest/consistent-test-it": ["error", { fn: "test" }],
    "vitest/expect-expect": "error",
    "vitest/no-conditional-expect": "error",
    "vitest/no-conditional-in-test": "error",
    "vitest/no-disabled-tests": "error",
    "vitest/no-focused-tests": "error",
    "vitest/no-identical-title": "error",
    "vitest/no-import-node-test": "error",
    "vitest/no-standalone-expect": "error",
    "vitest/prefer-strict-equal": "error",
    "vitest/valid-expect": "error",
    "vitest/valid-title": "error",

    "unicorn/error-message": "error",
    "unicorn/filename-case": [
      "error",
      {
        cases: {
          camelCase: true,
          kebabCase: true,
          pascalCase: true,
        },
      },
    ],
    "unicorn/prefer-array-flat-map": "error",
    "unicorn/prefer-node-protocol": "error",
    "unicorn/prefer-object-from-entries": "error",
    "unicorn/throw-new-error": "error",
  },
  env: {
    builtin: true,
    node: true,
    vitest: true,
  },
  ignorePatterns: ["**/dist/**", "**/coverage/**", "**/out/**", ".turbo/**"],
});

export default config;

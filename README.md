# ts-starter

A lean TypeScript starter extracted from `colorful-monorepo` without the VSIX-specific pieces.

## Tooling

- `mise` pins the runtime toolchain.
- `aube` runs install and package scripts.
- Node 24 is the baseline runtime.
- Node runs `.ts` files directly through native type stripping.
- `tsdown` builds publishable ESM output and emits declarations.
- `oxlint` and `oxfmt` keep code quality and formatting strict.
- `vitest` runs tests.

## TypeScript Setup

This starter is configured as a modern Node ESM package:

- `target` and `lib` are `ESNext`, matching Node's native TypeScript guidance.
- `module` is `NodeNext`, matching Node's ESM and TypeScript loading rules.
- Relative imports include `.ts` in source so Node can run files directly.
- `rewriteRelativeImportExtensions` rewrites source imports for emitted JavaScript.
- `verbatimModuleSyntax` keeps import/export syntax predictable.
- `isolatedModules` and `isolatedDeclarations` keep files build-tool friendly.
- `erasableSyntaxOnly` avoids TypeScript constructs that cannot be stripped cleanly.
- `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and related checks keep types tight.

## Commands

```sh
aube install
aube dev
aube verify
```

The same scripts also work through any compatible package runner:

```sh
npm run dev
npm run verify
```

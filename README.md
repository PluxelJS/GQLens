# GQLens

Monorepo for GQLens — GraphQL query lens tooling.

## Packages

| Package                 | Description                                   |
| ----------------------- | --------------------------------------------- |
| `@gqlens/core`          | Core library — query parsing and lens engine. |
| `@gqlens/react`         | React bindings — hooks and components.        |
| `@gqlens/solid`         | SolidJS bindings — primitives and signals.    |
| `@gqlens/oxlint-plugin` | Architectural lint rules for accessor usage.  |

## Tooling

- `mise` pins the runtime toolchain.
- `aube` manages dependencies and workspace orchestration.
- `turbo` orchestrates tasks with caching and dependency ordering.
- Node 24 is the baseline runtime.
- `tsdown` builds publishable ESM output and emits declarations.
- `oxlint` and `oxfmt` keep code quality and formatting strict.
- `vitest` runs tests.

## Commands

```
aube install
aube test
aube build
aube verify
```

# GQLens [![npm: @gqlens/core](https://img.shields.io/npm/v/%40gqlens%2Fcore?label=core)](https://www.npmjs.com/package/@gqlens/core) [![CI](https://github.com/PluxelJS/GQLens/actions/workflows/ci.yml/badge.svg)](https://github.com/PluxelJS/GQLens/actions/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

<p align="center">
  <img src="./docs/assets/gqlens-hero.svg" alt="GQLens QuerySession boundaries collect child component field reads into scoped GraphQL selections." />
</p>

GQLens is a demand-first GraphQL client for React and Solid. Generated accessors feed `QuerySession` scopes; each scope plans, caches, and fetches its own selection.

```sh
pnpm add @gqlens/core @gqlens/react
pnpm add -D @gqlens/codegen @gqlens/vite graphql
```

Use `@gqlens/solid` instead of `@gqlens/react` for Solid.

Read next:

- [Yoga + Vite example](./examples/yoga-vite-codegen/README.md)
- [API syntax spec](./docs/规范-API语法.md)
- [Framework adapters](./docs/06-框架适配.md)
- [Schema design guide](./docs/服务端-Schema设计指南.md)

## Development

```sh
pnpm install
pnpm run verify
pnpm run build
```

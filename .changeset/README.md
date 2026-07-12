# Changesets

GQLens keeps all `@gqlens/*` packages on one `major.minor` release line.

Use `pnpm changeset` for user-facing changes, then `pnpm run release:version`
to apply versions before publishing.

- Patch releases should list only the packages that changed.
- Minor and major releases should list every public `@gqlens/*` package, so all
  packages move to the same next release line together.

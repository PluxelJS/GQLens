# @gqlens/oxlint-plugin

This package owns GQLens architectural lint rules. It also documents the API shape required for those rules to stay fast and accurate across React, Solid, and framework-neutral TypeScript runtimes.

The plugin is implemented in TypeScript and loaded by oxlint through `jsPlugins`. Oxlint currently exposes `RuleTester` from `oxlint/plugins-dev`, but does not export a stable public `Rule` / `RuleContext` / AST type surface for plugin authors. The implementation therefore keeps a small local type boundary and avoids `any`; this can be replaced by official oxlint types once they are exported.

## API-First Boundary

Prefer API design over lint rules. A lint rule is justified only when an invalid pattern cannot be made unrepresentable by the generated API.

GQLens should keep one accessor shape across runtimes:

```ts
q.user({ id }).name;
q.todos({ done: false }).ids;
q.pet({ id }).$on.Cat.meows;
```

Frameworks may differ only in how a scoped runtime accessor is acquired. This is a host-runtime constraint, not a different accessor model:

```ts
// React
const q = useQuery();

// Solid
const q = createQuery();
```

React entries that call React Hooks must keep the `use*` shape. Solid entries should keep the `create*` primitive shape. A framework-neutral runtime should also use `createQuery`, not a bare `query()` name, because `query()` is ambiguous and sounds like an immediate transport operation.

After `q` exists, the accessor graph is identical. The current rules recognize the canonical entry names above. Generated lint manifests can later replace these defaults when codegen emits project-specific entry names.

## Unified Accessor Contexts

All generated accessors must run in one of three explicit contexts.

### Runtime Read Context

```ts
const q = useQuery();
q.user({ id }).name;
```

Semantics:

```
terminal read = demand + read signal
relation read = advance path only
```

Runtime read context may subscribe to field signals and schedule requests.

### Prepared Selection Context

```ts
const userCard = defineSelection((q, v) => {
  q.user({ id: v("id") }).name;
  q.user({ id: v("id") }).avatar;
});
```

Semantics:

```
terminal read = collect selection path only
relation read = advance path only
```

Prepared selection does not read signals, subscribe readers, or schedule by itself. It only produces selection paths, variable shape, and optional stable operation metadata.

### Invalidation Selector Context

```ts
const changedTodos = defineInvalidation((q) => q.todos({ done: false }).ids);
```

Semantics:

```
terminal read = collect affected path / slot only
relation read = advance path only
```

Invalidation selectors do not read cache signals and do not mutate active selection.

## API Must Prevent These

These should be impossible or strongly typed away before lint runs.

### Lists Are Not Arrays

Generated list accessors expose only identity fields:

```ts
q.todos({ done: false }).ids;
```

Do not generate:

```ts
q.todos({ done: false }).map(...);
q.todos({ done: false })[0];
q.todos({ done: false }).item(id);
q.todos({ done: false }).node(id);
```

Rows must re-enter through explicit root accessor:

```ts
q.todo({ id }).title;
```

### Prepared Variables Are Explicit

Use `v("id")`, not magic strings:

```ts
defineSelection((q, v) => {
  q.user({ id: v("id") }).name;
});
```

Do not support:

```ts
q.user({ id: "$id" }).name;
```

### No Dynamic Field API

Do not expose generic field access:

```ts
q.field("user", args).field("name");
q.read(path);
q.select("Query.user.name");
```

Dynamic field APIs bypass codegen metadata and make lint/type checking imprecise.

### Selector API Is Separate

Do not overload runtime `q` with selector behavior:

```ts
q.invalidate((x) => x.todos({ done: false }).ids);
```

Prefer explicit selector builders:

```ts
defineInvalidation((q) => q.todos({ done: false }).ids);
defineSelection((q, v) => q.user({ id: v("id") }).name);
```

This lets lint distinguish runtime read, prepared selection, and invalidation selector without type-aware control-flow analysis.

## Errors That Still Need Lint

These patterns cannot be fully prevented by TypeScript or generated API shape, especially when accessors cross callback, component, or adapter boundaries.

### `gqlens/no-accessor-escape`

Accessor nodes must not escape their reader scope.

Invalid:

```tsx
const user = q.user({ id });
return <UserCard user={user} />;
```

Invalid:

```ts
const user = q.user({ id });
cache.set("user", user);
return user;
```

Valid:

```ts
const user = q.user({ id });
user.name;
user.avatar;
```

Rationale: accessor nodes are path lenses bound to a context. Passing them across component/function boundaries can move field reads into the wrong reader scope.

### `gqlens/no-untracked-read`

Field terminals must be read only in an explicit GQLens context.

Invalid:

```ts
useEffect(() => {
  q.user({ id }).name;
}, [id]);
```

Invalid:

```ts
button.onclick = () => {
  q.viewer.name;
};
```

Valid contexts:

- render/runtime read context
- `defineSelection((q, v) => ...)`
- `defineInvalidation((q) => ...)`
- future explicit `peek()` API, if designed

### `gqlens/no-accessor-object-ops`

Accessor nodes are not data objects.

Invalid:

```ts
{ ...q.viewer };
Object.keys(q.user({ id }));
JSON.stringify(q.viewer);
"name" in q.viewer;
for (const key in q.viewer) {}
```

Rationale: object operations reintroduce proxy-like object semantics and can accidentally touch non-field properties.

### `gqlens/selector-pure`

Prepared selections and invalidation selectors must be pure path collectors.

Invalid:

```ts
defineSelection((q, v) => {
  if (Math.random() > 0.5) q.user({ id: v("id") }).name;
  fetch("/x");
});
```

Invalid:

```ts
defineSelection((q, v) => {
  const readName = () => q.user({ id: v("id") }).name;
  readName();
});
```

Invalid:

```ts
defineInvalidation((q) => {
  console.log("invalidate");
  return q.todos({ done: false }).ids;
});
```

Allowed operations:

- accessor getter / function calls
- plain object / array literals for args
- `v("name")` variable placeholders in prepared selection
- direct return of a terminal path or root / relation identity slot in invalidation selector

### `gqlens/plain-args`

Args must be canonical GraphQL input values.

Invalid:

```ts
q.todos({ filter: () => true }).ids;
q.events({ after: new Date() }).ids;
q.search(new Map()).ids;
```

Allowed values:

- string / number / boolean / null
- arrays of allowed values
- plain objects of allowed values
- prepared variables from `v("name")`
- identifiers whose values cannot be proven invalid

This rule is intentionally conservative: TypeScript catches many non-input values earlier, while oxlint still catches obvious runtime factories and nested invalid literals.

## Lint Manifest

Codegen should emit a manifest next to generated accessors:

```json
{
  "version": 1,
  "module": "./accessor",
  "runtimeEntries": ["useQuery", "useLiveQuery", "createQuery", "createLiveQuery"],
  "selectorEntries": ["defineSelection", "defineInvalidation"],
  "roots": {
    "Query": {
      "user": { "kind": "entity", "hasArgs": true, "type": "User" },
      "todos": { "kind": "list", "hasArgs": true, "type": "Todo" }
    }
  },
  "types": {
    "User": {
      "name": { "kind": "scalar" },
      "posts": { "kind": "list", "hasArgs": true, "type": "Post" }
    }
  },
  "possibleTypes": {
    "Pet": ["Cat", "Dog"]
  }
}
```

The oxlint plugin should prefer this manifest over type-checker integration. It keeps rules fast and lets linting work without requiring framework-specific type programs.

## Rule Priority

Implemented:

1. `gqlens/no-accessor-escape`
2. `gqlens/no-untracked-read`
3. `gqlens/no-accessor-object-ops`
4. `gqlens/selector-pure`
5. `gqlens/plain-args` conservative validation

Manifest-backed candidates:

1. `gqlens/list-terminal-only`
2. `gqlens/fragment-access` for `$on.<Type>` validation
3. schema-aware `gqlens/plain-args` extension beyond obvious non-input factories

Rules should report architecture violations, not style preferences.

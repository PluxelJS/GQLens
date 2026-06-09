import { isVariablePlaceholder, stepKey } from "../src/keys";
import type {
  AlienSignalReader,
  CacheInvalidation,
  EntityRef,
  FieldSignal,
  NormalizedCache,
  PreparedSelection,
  PlannerMetadata,
  SelectionPath,
  SelectionStep,
  VariablePlaceholder,
} from "../src/types";

const accessorMeta = Symbol("gqlens.accessorMeta");

export interface EntityMeta {
  readonly type: string;
  readonly kind?: "entity" | "value" | "root" | undefined;
  readonly identityKeys: readonly string[];
  readonly fields: Readonly<Record<string, FieldMeta>>;
  readonly possibleTypes?: readonly string[] | undefined;
  readonly typeConditions?: readonly string[] | undefined;
  readonly isAbstract?: boolean | undefined;
}

export interface FieldMeta {
  readonly name: string;
  readonly kind: "scalar" | "entity" | "value" | "list";
  readonly typeName?: string | undefined;
  readonly targetObjectKind?: "entity" | "value" | undefined;
  readonly hasArgs?: boolean | undefined;
  readonly isAbstract?: boolean | undefined;
  readonly possibleTypes?: readonly string[] | undefined;
}

export interface SchemaMeta {
  readonly query: EntityMeta;
  readonly mutation?: EntityMeta | undefined;
  readonly planner?: PlannerMetadata | undefined;
  readonly entities: Readonly<Record<string, EntityMeta>>;
}

export interface AccessorContext {
  readonly root: string;
  readonly cache: NormalizedCache;
  readonly demand: (steps: readonly SelectionStep[]) => void;
  readonly read: <T>(sig: AlienSignalReader<T>) => T;
}

interface AccessorNodeMeta {
  readonly steps: readonly SelectionStep[];
}

interface ResolvedOwner {
  readonly ref: EntityRef;
  readonly fieldSteps: readonly SelectionStep[];
}

export interface NormalizerEntry {
  readonly type: string;
  readonly fields: readonly NormalizerField[];
}

export interface NormalizerField {
  readonly responseKey: string;
  readonly cacheKey: string;
  readonly nestedType?: string | undefined;
  readonly isList?: boolean | undefined;
}

export function createAccessorNode<T extends object>(
  ctx: AccessorContext,
  schema: SchemaMeta,
  meta: EntityMeta,
  steps: readonly SelectionStep[] = [],
  ownerResolver?: () => ResolvedOwner | undefined,
): T {
  const target = {};
  const childCache = new Map<string, unknown>();
  Object.defineProperty(target, accessorMeta, {
    enumerable: false,
    value: { steps } satisfies AccessorNodeMeta,
  });

  for (const field of Object.values(meta.fields)) {
    if (field.hasArgs) {
      Object.defineProperty(target, field.name, {
        enumerable: false,
        value: (args?: Record<string, unknown>) => {
          const nextSteps = [...steps, { field: field.name, args }];
          if (field.kind === "scalar") {
            return readField(ctx, schema, field, nextSteps, ownerResolver);
          }
          return readCachedField(ctx, schema, field, nextSteps, ownerResolver, childCache);
        },
      });
      continue;
    }

    Object.defineProperty(target, field.name, {
      enumerable: false,
      get: () => {
        const nextSteps = [...steps, { field: field.name }];
        if (field.kind === "scalar") {
          return readField(ctx, schema, field, nextSteps, ownerResolver);
        }
        return readCachedField(ctx, schema, field, nextSteps, ownerResolver, childCache);
      },
    });
  }

  const typeConditions = meta.typeConditions ?? meta.possibleTypes ?? [];
  if (typeConditions.length > 0) {
    Object.defineProperty(target, "$on", {
      enumerable: false,
      get: () => createInlineFragmentAccessors(ctx, schema, steps, ownerResolver, typeConditions),
    });
  }

  return target as T;
}

function readCachedField(
  ctx: AccessorContext,
  schema: SchemaMeta,
  field: FieldMeta,
  steps: readonly SelectionStep[],
  ownerResolver: (() => ResolvedOwner | undefined) | undefined,
  cache: Map<string, unknown>,
): unknown {
  const key = cacheFieldKey(steps);
  if (cache.has(key)) {
    return cache.get(key);
  }
  const value = readField(ctx, schema, field, steps, ownerResolver);
  cache.set(key, value);
  return value;
}

function readField(
  ctx: AccessorContext,
  schema: SchemaMeta,
  field: FieldMeta,
  steps: readonly SelectionStep[],
  ownerResolver: (() => ResolvedOwner | undefined) | undefined,
): unknown {
  if (field.kind === "scalar") {
    ctx.demand(steps);
    const owner = ownerResolver?.();
    const entry = owner
      ? ctx.cache.entry({
          owner: { kind: "entity", ref: owner.ref },
          path: scalarPath(owner, steps),
        })
      : ctx.cache.entry({ owner: { kind: "root", root: ctx.root }, path: steps });
    return ctx.read(entry.sig);
  }

  if (field.kind === "list") {
    return createListAccessor(ctx, steps, ownerResolver, field.isAbstract === true);
  }

  const childMeta = field.typeName ? schema.entities[field.typeName] : undefined;
  if (!childMeta) {
    return createAccessorNode(ctx, schema, schema.query, steps);
  }

  if (field.kind === "value" || field.targetObjectKind === "value" || childMeta.kind === "value") {
    return createAccessorNode(ctx, schema, childMeta, steps, () => {
      const owner = ownerResolver?.();
      if (!owner) {
        return undefined;
      }
      const step = lastStep(steps);
      return step ? { ref: owner.ref, fieldSteps: [...owner.fieldSteps, step] } : owner;
    });
  }

  return createAccessorNode(ctx, schema, childMeta, steps, () => {
    const step = lastStep(steps);
    if (!step) {
      return undefined;
    }

    if (!ownerResolver) {
      const slot = ctx.cache.entry<EntityRef | null | undefined>({
        owner: { kind: "root", root: ctx.root },
        path: steps,
      });
      const resolved = ctx.read<EntityRef | null | undefined>(slot.sig);
      if (resolved !== undefined) {
        return resolved ? { ref: resolved, fieldSteps: [] } : undefined;
      }

      const id = step.args?.["id"];
      if (field.typeName && id !== undefined && !childMeta.isAbstract) {
        return { ref: ctx.cache.entity(field.typeName, String(id)), fieldSteps: [] };
      }
    }

    const owner = ownerResolver?.();
    if (owner) {
      const relationStep =
        owner.fieldSteps.length > 0
          ? { ...step, field: cacheFieldKey([...owner.fieldSteps, step]) }
          : step;
      const relation = ctx.cache.entry<EntityRef | null | undefined>({
        owner: { kind: "entity", ref: owner.ref },
        path: [relationStep],
        facet: "link",
      });
      const ref = ctx.read<EntityRef | null | undefined>(relation.sig);
      return ref ? { ref, fieldSteps: [] } : undefined;
    }
    const slot = ctx.cache.entry<EntityRef | undefined>({
      owner: { kind: "root", root: ctx.root },
      path: steps,
    });
    const ref = ctx.read<EntityRef | undefined>(slot.sig);
    return ref ? { ref, fieldSteps: [] } : undefined;
  });
}

function createInlineFragmentAccessors(
  ctx: AccessorContext,
  schema: SchemaMeta,
  steps: readonly SelectionStep[],
  ownerResolver: (() => ResolvedOwner | undefined) | undefined,
  typeConditions: readonly string[],
): object {
  const target = {};
  for (const typeName of typeConditions) {
    const meta = schema.entities[typeName];
    if (!meta) {
      continue;
    }
    Object.defineProperty(target, typeName, {
      enumerable: false,
      get: () =>
        createAccessorNode(
          ctx,
          schema,
          meta,
          [...steps, { field: "$on", typeCondition: typeName }],
          () => {
            const owner = ownerResolver?.();
            if (!owner || !matchesTypeCondition(meta, owner.ref)) {
              return undefined;
            }
            return { ref: owner.ref, fieldSteps: [] };
          },
        ),
    });
  }
  return target;
}

function createListAccessor(
  ctx: AccessorContext,
  steps: readonly SelectionStep[],
  ownerResolver: (() => ResolvedOwner | undefined) | undefined,
  isAbstract: boolean,
): {
  readonly ids?: readonly string[] | undefined;
  readonly refs?: readonly EntityRef[] | undefined;
} {
  const target = {};
  Object.defineProperty(target, accessorMeta, {
    enumerable: false,
    value: { steps } satisfies AccessorNodeMeta,
  });
  const identityField = isAbstract ? "refs" : "ids";
  Object.defineProperty(target, identityField, {
    enumerable: false,
    get(): readonly string[] | readonly EntityRef[] | undefined {
      ctx.demand([...steps, { field: identityField }]);
      const owner = ownerResolver?.();
      if (owner) {
        const step = lastStep(steps);
        if (!step) {
          return undefined;
        }
        const relationStep =
          owner.fieldSteps.length > 0
            ? { ...step, field: cacheFieldKey([...owner.fieldSteps, step]) }
            : step;
        const slot = ctx.cache.entry<readonly string[] | readonly EntityRef[] | undefined>({
          owner: { kind: "entity", ref: owner.ref },
          path: [relationStep],
          facet: identityField,
        });
        return ctx.read(
          slot.sig as AlienSignalReader<readonly string[] | readonly EntityRef[] | undefined>,
        );
      }
      const entry = ctx.cache.entry<readonly string[] | readonly EntityRef[] | undefined>({
        owner: { kind: "root", root: ctx.root },
        path: steps,
        facet: identityField,
      });
      return ctx.read(
        entry.sig as AlienSignalReader<readonly string[] | readonly EntityRef[] | undefined>,
      );
    },
  });
  return target as {
    readonly ids?: readonly string[] | undefined;
    readonly refs?: readonly EntityRef[] | undefined;
  };
}

function cacheFieldKey(steps: readonly SelectionStep[]): string {
  return steps
    .filter((step) => !step.typeCondition)
    .map(stepKey)
    .join(".");
}

function scalarPath(
  owner: ResolvedOwner,
  steps: readonly SelectionStep[],
): readonly SelectionStep[] {
  const step = lastStep(steps);
  return step ? [...owner.fieldSteps, step] : owner.fieldSteps;
}

function lastStep(steps: readonly SelectionStep[]): SelectionStep | undefined {
  return steps[steps.length - 1];
}

function matchesTypeCondition(meta: EntityMeta, ref: EntityRef): boolean {
  return ref.type === meta.type || (meta.possibleTypes?.includes(ref.type) ?? false);
}

export type { EntityRef, SelectionStep };

export function defineSelection<TQuery extends object>(
  schema: SchemaMeta,
  queryMeta: EntityMeta,
  callback: (q: TQuery, v: (name: string) => VariablePlaceholder) => void,
): PreparedSelection {
  const paths: SelectionPath[] = [];
  const variables = new Set<string>();
  const query = createAccessorNode<TQuery>(
    selectorContext(schema.query.type, paths),
    schema,
    queryMeta,
  );
  callback(query, (name) => {
    variables.add(name);
    return { __gqlensVariable: name };
  });
  return { paths, variables: [...variables] };
}

export function bindSelection(
  selection: PreparedSelection,
  variables: Readonly<Record<string, unknown>>,
): SelectionPath[] {
  return selection.paths.map((path) => ({
    root: path.root,
    steps: path.steps.map((step) =>
      step.args ? { ...step, args: bindArgs(step.args, variables) } : step,
    ),
  }));
}

export function defineInvalidation<TQuery extends object>(
  schema: SchemaMeta,
  queryMeta: EntityMeta,
  callback: (q: TQuery) => unknown,
): CacheInvalidation {
  const paths: SelectionPath[] = [];
  const ctx = selectorContext(schema.query.type, paths);
  const query = createAccessorNode<TQuery>(ctx, schema, queryMeta);
  const result = callback(query);
  if (paths[0]) {
    return { kind: "selection", path: paths[0], metadata: schema.planner };
  }
  const steps = accessorSteps(result);
  return { kind: "root", root: schema.query.type, paths: [steps] };
}

function selectorContext(root: string, paths: SelectionPath[]): AccessorContext {
  const cache = selectorCache();
  return {
    root,
    cache,
    demand(steps) {
      paths.push({ root, steps });
    },
    read(sig) {
      return sig();
    },
  };
}

function selectorCache(): NormalizedCache {
  return {
    entry: <T = unknown>() => selectorEntry<T>(),
    peek: () => undefined,
    read: () => undefined,
    write: selectorNoop,
    isFresh: () => false,
    transaction(run) {
      return {
        result: run(this),
        rollback: selectorNoop,
      };
    },
    entity(type: string, id: string): EntityRef {
      return { type, id };
    },
    normalize: selectorNoop,
    invalidate: selectorNoop,
    clear: selectorNoop,
  };
}

function selectorNoop(): void {
  return undefined;
}

function selectorEntry<T>(): FieldSignal<T> {
  return {
    sig: (() => undefined) as unknown as FieldSignal<T>["sig"],
    expires: 0,
  };
}

function accessorSteps(value: unknown): readonly SelectionStep[] {
  if (value && typeof value === "object" && accessorMeta in value) {
    return (value as { readonly [accessorMeta]: AccessorNodeMeta })[accessorMeta].steps;
  }
  return [];
}

function bindValue(value: unknown, variables: Readonly<Record<string, unknown>>): unknown {
  if (isVariablePlaceholder(value)) {
    const name = value["__gqlensVariable"];
    if (!Object.hasOwn(variables, name)) {
      throw new Error(`Missing GQLens prepared selection variable: ${name}`);
    }
    return variables[name];
  }
  if (Array.isArray(value)) {
    return value.map((item) => bindValue(item, variables));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, bindValue(item, variables)]),
    );
  }
  return value;
}

function bindArgs(
  args: Record<string, unknown>,
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return bindValue(args, variables) as Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

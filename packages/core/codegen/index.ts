import { relationSlotKey, slotKey, stepKey } from "../src/keys";
import type {
  AlienSignalReader,
  EntityRef,
  FieldSignal,
  InvalidationTarget,
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
  readonly identityKeys: readonly string[];
  readonly fields: Readonly<Record<string, FieldMeta>>;
  readonly possibleTypes?: readonly string[] | undefined;
  readonly typeConditions?: readonly string[] | undefined;
  readonly isAbstract?: boolean | undefined;
}

export interface FieldMeta {
  readonly name: string;
  readonly kind: "scalar" | "entity" | "list";
  readonly typeName?: string | undefined;
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
  refResolver?: () => EntityRef | undefined,
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
            return readField(ctx, schema, field, nextSteps, refResolver);
          }
          return readCachedField(ctx, schema, field, nextSteps, refResolver, childCache);
        },
      });
      continue;
    }

    Object.defineProperty(target, field.name, {
      enumerable: false,
      get: () => {
        const nextSteps = [...steps, { field: field.name }];
        if (field.kind === "scalar") {
          return readField(ctx, schema, field, nextSteps, refResolver);
        }
        return readCachedField(ctx, schema, field, nextSteps, refResolver, childCache);
      },
    });
  }

  const typeConditions = meta.typeConditions ?? meta.possibleTypes ?? [];
  if (typeConditions.length > 0) {
    Object.defineProperty(target, "$on", {
      enumerable: false,
      get: () => createInlineFragmentAccessors(ctx, schema, steps, refResolver, typeConditions),
    });
  }

  return target as T;
}

function readCachedField(
  ctx: AccessorContext,
  schema: SchemaMeta,
  field: FieldMeta,
  steps: readonly SelectionStep[],
  refResolver: (() => EntityRef | undefined) | undefined,
  cache: Map<string, unknown>,
): unknown {
  const key = cacheFieldKey(steps);
  if (cache.has(key)) {
    return cache.get(key);
  }
  const value = readField(ctx, schema, field, steps, refResolver);
  cache.set(key, value);
  return value;
}

function readField(
  ctx: AccessorContext,
  schema: SchemaMeta,
  field: FieldMeta,
  steps: readonly SelectionStep[],
  refResolver: (() => EntityRef | undefined) | undefined,
): unknown {
  if (field.kind === "scalar") {
    ctx.demand(steps);
    const ref = refResolver?.();
    const entry = ref
      ? ctx.cache.field(ref, cacheFieldKey(steps))
      : ctx.cache.slot(slotKey(ctx.root, steps));
    return ctx.read(entry.sig);
  }

  if (field.kind === "list") {
    return createListAccessor(ctx, steps, refResolver, field.isAbstract === true);
  }

  const childMeta = field.typeName ? schema.entities[field.typeName] : undefined;
  if (!childMeta) {
    return createAccessorNode(ctx, schema, schema.query, steps);
  }

  return createAccessorNode(ctx, schema, childMeta, steps, () => {
    const step = lastStep(steps);
    if (!step) {
      return undefined;
    }

    if (!refResolver) {
      const key = slotKey(ctx.root, steps);
      const slot = ctx.cache.slot<EntityRef | null | undefined>(key);
      const resolved = ctx.read<EntityRef | null | undefined>(slot.sig);
      if (resolved !== undefined) {
        return resolved ?? undefined;
      }

      const id = step.args?.["id"];
      if (field.typeName && id !== undefined && !childMeta.isAbstract) {
        return ctx.cache.entity(field.typeName, String(id));
      }
    }

    const ref = refResolver?.();
    if (ref) {
      const relation = ctx.cache.slot<EntityRef | null | undefined>(relationSlotKey(ref, step));
      return ctx.read<EntityRef | null | undefined>(relation.sig) ?? undefined;
    }
    const slot = ctx.cache.slot<EntityRef | undefined>(slotKey(ctx.root, steps));
    return ctx.read<EntityRef | undefined>(slot.sig);
  });
}

function createInlineFragmentAccessors(
  ctx: AccessorContext,
  schema: SchemaMeta,
  steps: readonly SelectionStep[],
  refResolver: (() => EntityRef | undefined) | undefined,
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
            const ref = refResolver?.();
            if (!ref || !matchesTypeCondition(meta, ref)) {
              return undefined;
            }
            return ref;
          },
        ),
    });
  }
  return target;
}

function createListAccessor(
  ctx: AccessorContext,
  steps: readonly SelectionStep[],
  refResolver: (() => EntityRef | undefined) | undefined,
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
      const ref = refResolver?.();
      if (ref) {
        const step = lastStep(steps);
        if (!step) {
          return undefined;
        }
        const slot = ctx.cache.slot<readonly string[] | readonly EntityRef[] | undefined>(
          relationSlotKey(ref, step, identityField),
        );
        return ctx.read(
          slot.sig as AlienSignalReader<readonly string[] | readonly EntityRef[] | undefined>,
        );
      }
      const entry = ctx.cache.slot<readonly string[] | readonly EntityRef[] | undefined>(
        slotKey(ctx.root, steps, identityField),
      );
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
  const step = lastStep(steps);
  return step ? stepKey(step) : "";
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

export function defineInvalidation<TQuery extends object>(
  schema: SchemaMeta,
  queryMeta: EntityMeta,
  callback: (q: TQuery) => unknown,
): InvalidationTarget {
  const paths: SelectionPath[] = [];
  const ctx = selectorContext(schema.query.type, paths);
  const query = createAccessorNode<TQuery>(ctx, schema, queryMeta);
  const result = callback(query);
  if (paths[0]) {
    return { kind: "selection", path: paths[0] };
  }
  const steps = accessorSteps(result);
  return { kind: "root", root: schema.query.type, steps };
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
    field: <T = unknown>() => selectorEntry<T>(),
    slot: <T = unknown>() => selectorEntry<T>(),
    entity(type: string, id: string): EntityRef {
      return { type, id };
    },
    normalize: selectorNoop,
    invalidate: selectorNoop,
    invalidateSlot: selectorNoop,
    isCached: () => false,
    isSlotCached: () => false,
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

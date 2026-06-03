import { slotKey, stepKey } from "../src/keys";
import type {
  AlienSignalReader,
  EntityRef,
  NormalizedCache,
  PlannerMetadata,
  SelectionStep,
} from "../src/types";

export interface EntityMeta {
  readonly type: string;
  readonly identityKeys: readonly string[];
  readonly fields: Readonly<Record<string, FieldMeta>>;
}

export interface FieldMeta {
  readonly name: string;
  readonly kind: "scalar" | "entity" | "list";
  readonly typeName?: string | undefined;
  readonly hasArgs?: boolean | undefined;
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
    return createListAccessor(ctx, steps, refResolver);
  }

  const childMeta = field.typeName ? schema.entities[field.typeName] : undefined;
  if (!childMeta) {
    return createAccessorNode(ctx, schema, schema.query, steps);
  }

  return createAccessorNode(ctx, schema, childMeta, steps, () => {
    const id = steps[steps.length - 1]?.args?.["id"];
    if (!refResolver && field.typeName && id !== undefined) {
      return ctx.cache.entity(field.typeName, String(id));
    }
    const ref = refResolver?.();
    if (ref) {
      const relation = ctx.cache.field<EntityRef | undefined>(ref, `${cacheFieldKey(steps)}_ref`);
      return ctx.read<EntityRef | undefined>(relation.sig);
    }
    const slot = ctx.cache.slot<EntityRef | undefined>(slotKey(ctx.root, steps));
    return ctx.read<EntityRef | undefined>(slot.sig);
  });
}

function createListAccessor(
  ctx: AccessorContext,
  steps: readonly SelectionStep[],
  refResolver: (() => EntityRef | undefined) | undefined,
): { readonly ids: readonly string[] } {
  const target = {};
  Object.defineProperty(target, "ids", {
    enumerable: false,
    get(): readonly string[] {
      ctx.demand([...steps, { field: "ids" }]);
      const ref = refResolver?.();
      if (ref) {
        const field = ctx.cache.field<readonly string[]>(ref, `${cacheFieldKey(steps)}_ids`);
        return ctx.read(field.sig) ?? [];
      }
      const entry = ctx.cache.slot<readonly string[]>(slotKey(ctx.root, steps, "ids"));
      return ctx.read(entry.sig) ?? [];
    },
  });
  return target as { readonly ids: readonly string[] };
}

function cacheFieldKey(steps: readonly SelectionStep[]): string {
  const step = steps[steps.length - 1];
  return step ? stepKey(step) : "";
}

export type { EntityRef, SelectionStep };

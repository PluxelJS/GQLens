import { isVariablePlaceholder, stepKey } from "../src/keys";
import { GQLensError } from "../src/error";
import type {
  AlienSignalReader,
  GraphDataInvalidation,
  EntityRef,
  FieldSignal,
  GraphDataStore,
  GraphDataRuntimeStore,
  PreparedSelection,
  GQLensFieldContract,
  GQLensObjectContract,
  GQLensSchemaContract,
  SelectionPath,
  SelectionStep,
  VariablePlaceholder,
} from "../src/types";

const accessorState = Symbol("gqlens.accessorState");

export type { GQLensFieldContract, GQLensObjectContract, GQLensSchemaContract };

export interface AccessorContext {
  readonly root: string;
  readonly store: GraphDataStore;
  readonly demand: (steps: readonly SelectionStep[]) => void;
  readonly read: <T>(sig: AlienSignalReader<T>) => T;
}

interface AccessorNodeState {
  readonly steps: readonly SelectionStep[];
}

interface ResolvedOwner {
  readonly ref: EntityRef;
  readonly fieldSteps: readonly SelectionStep[];
}

export function createAccessorNode<T extends object>(
  ctx: AccessorContext,
  schema: GQLensSchemaContract,
  contract: GQLensObjectContract,
  steps: readonly SelectionStep[] = [],
  ownerResolver?: () => ResolvedOwner | undefined,
): T {
  const target = {};
  const childCache = new Map<string, unknown>();
  Object.defineProperty(target, accessorState, {
    enumerable: false,
    value: { steps } satisfies AccessorNodeState,
  });

  for (const field of Object.values(contract.fields)) {
    if (field.args) {
      Object.defineProperty(target, field.name, {
        enumerable: false,
        value: (args?: Record<string, unknown>) => {
          const nextSteps = [...steps, { field: field.name, args }];
          if (field.result.kind === "scalar") {
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
        if (field.result.kind === "scalar") {
          return readField(ctx, schema, field, nextSteps, ownerResolver);
        }
        return readCachedField(ctx, schema, field, nextSteps, ownerResolver, childCache);
      },
    });
  }

  const typeConditions = contract.typeConditions ?? contract.possibleTypes ?? [];
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
  schema: GQLensSchemaContract,
  field: GQLensFieldContract,
  steps: readonly SelectionStep[],
  ownerResolver: (() => ResolvedOwner | undefined) | undefined,
  cache: Map<string, unknown>,
): unknown {
  const key = graphDataFieldKey(steps);
  if (cache.has(key)) {
    return cache.get(key);
  }
  const value = readField(ctx, schema, field, steps, ownerResolver);
  cache.set(key, value);
  return value;
}

function readField(
  ctx: AccessorContext,
  schema: GQLensSchemaContract,
  field: GQLensFieldContract,
  steps: readonly SelectionStep[],
  ownerResolver: (() => ResolvedOwner | undefined) | undefined,
): unknown {
  if (field.result.kind === "scalar") {
    ctx.demand(steps);
    const owner = ownerResolver?.();
    const store = runtimeStore(ctx.store);
    const entry = owner
      ? store.entry({
          owner: { kind: "entity", ref: owner.ref },
          path: scalarPath(owner, steps),
        })
      : store.entry({ owner: { kind: "root", root: ctx.root }, path: steps });
    return ctx.read(entry.sig);
  }

  if (field.result.cardinality === "list") {
    return createListAccessor(ctx, steps, ownerResolver, field.result.isAbstract === true);
  }

  const typeName = field.result.typeName;
  const childContract = schema.objects[typeName];
  if (!childContract) {
    return createAccessorNode(ctx, schema, schema.query, steps);
  }

  if (field.result.objectKind === "value" || childContract.kind === "value") {
    return createAccessorNode(ctx, schema, childContract, steps, () => {
      const owner = ownerResolver?.();
      if (!owner) {
        return undefined;
      }
      const step = lastStep(steps);
      return step ? { ref: owner.ref, fieldSteps: [...owner.fieldSteps, step] } : owner;
    });
  }

  return createAccessorNode(ctx, schema, childContract, steps, () => {
    const step = lastStep(steps);
    if (!step) {
      return undefined;
    }

    if (!ownerResolver) {
      const slot = runtimeStore(ctx.store).entry<EntityRef | null | undefined>({
        owner: { kind: "root", root: ctx.root },
        path: steps,
      });
      const resolved = ctx.read<EntityRef | null | undefined>(slot.sig);
      if (resolved !== undefined) {
        return resolved ? { ref: resolved, fieldSteps: [] } : undefined;
      }

      const id = step.args?.["id"];
      if (id !== undefined && !childContract.isAbstract) {
        return { ref: ctx.store.entity(typeName, String(id)), fieldSteps: [] };
      }
    }

    const owner = ownerResolver?.();
    if (owner) {
      const relationStep =
        owner.fieldSteps.length > 0
          ? { ...step, field: graphDataFieldKey([...owner.fieldSteps, step]) }
          : step;
      const relation = runtimeStore(ctx.store).entry<EntityRef | null | undefined>({
        owner: { kind: "entity", ref: owner.ref },
        path: [relationStep],
        facet: "link",
      });
      const ref = ctx.read<EntityRef | null | undefined>(relation.sig);
      return ref ? { ref, fieldSteps: [] } : undefined;
    }
    const slot = runtimeStore(ctx.store).entry<EntityRef | undefined>({
      owner: { kind: "root", root: ctx.root },
      path: steps,
    });
    const ref = ctx.read<EntityRef | undefined>(slot.sig);
    return ref ? { ref, fieldSteps: [] } : undefined;
  });
}

function createInlineFragmentAccessors(
  ctx: AccessorContext,
  schema: GQLensSchemaContract,
  steps: readonly SelectionStep[],
  ownerResolver: (() => ResolvedOwner | undefined) | undefined,
  typeConditions: readonly string[],
): object {
  const target = {};
  for (const typeName of typeConditions) {
    const contract = schema.objects[typeName];
    if (!contract) {
      continue;
    }
    Object.defineProperty(target, typeName, {
      enumerable: false,
      get: () =>
        createAccessorNode(
          ctx,
          schema,
          contract,
          [...steps, { field: "$on", typeCondition: typeName }],
          () => {
            const owner = ownerResolver?.();
            if (!owner || !matchesTypeCondition(contract, owner.ref)) {
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
  Object.defineProperty(target, accessorState, {
    enumerable: false,
    value: { steps } satisfies AccessorNodeState,
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
            ? { ...step, field: graphDataFieldKey([...owner.fieldSteps, step]) }
            : step;
        const slot = runtimeStore(ctx.store).entry<
          readonly string[] | readonly EntityRef[] | undefined
        >({
          owner: { kind: "entity", ref: owner.ref },
          path: [relationStep],
          facet: identityField,
        });
        return ctx.read(
          slot.sig as AlienSignalReader<readonly string[] | readonly EntityRef[] | undefined>,
        );
      }
      const entry = runtimeStore(ctx.store).entry<
        readonly string[] | readonly EntityRef[] | undefined
      >({
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

function graphDataFieldKey(steps: readonly SelectionStep[]): string {
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

function runtimeStore(store: GraphDataStore): GraphDataRuntimeStore {
  return store as GraphDataRuntimeStore;
}

function matchesTypeCondition(contract: GQLensObjectContract, ref: EntityRef): boolean {
  return ref.type === contract.type || (contract.possibleTypes?.includes(ref.type) ?? false);
}

export type { EntityRef, SelectionStep };

export function defineSelection<TQuery extends object>(
  schema: GQLensSchemaContract,
  queryContract: GQLensObjectContract,
  callback: (q: TQuery, v: (name: string) => VariablePlaceholder) => void,
): PreparedSelection {
  const paths: SelectionPath[] = [];
  const variables = new Set<string>();
  const query = createAccessorNode<TQuery>(
    selectorContext(schema.query.type, paths),
    schema,
    queryContract,
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
  schema: GQLensSchemaContract,
  queryContract: GQLensObjectContract,
  callback: (q: TQuery) => unknown,
): GraphDataInvalidation {
  const paths: SelectionPath[] = [];
  const ctx = selectorContext(schema.query.type, paths);
  const query = createAccessorNode<TQuery>(ctx, schema, queryContract);
  const result = callback(query);
  if (paths[0]) {
    return { kind: "selection", path: paths[0], schema };
  }
  const steps = accessorSteps(result);
  return { kind: "root", root: schema.query.type, paths: [steps] };
}

function selectorContext(root: string, paths: SelectionPath[]): AccessorContext {
  const store = selectorStore();
  return {
    root,
    store,
    demand(steps) {
      paths.push({ root, steps });
    },
    read(sig) {
      return sig();
    },
  };
}

function selectorStore(): GraphDataRuntimeStore {
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
    writeGraphQLResult: selectorNoop,
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
  if (value && typeof value === "object" && accessorState in value) {
    return (value as { readonly [accessorState]: AccessorNodeState })[accessorState].steps;
  }
  return [];
}

function bindValue(value: unknown, variables: Readonly<Record<string, unknown>>): unknown {
  if (isVariablePlaceholder(value)) {
    const name = value["__gqlensVariable"];
    if (!Object.hasOwn(variables, name)) {
      throw new GQLensError({
        code: "PREPARED_VARIABLE_MISSING",
        message: `Missing GQLens prepared selection variable: ${name}`,
        details: { name },
      });
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

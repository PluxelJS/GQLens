import type {
  GQLensFieldContract,
  GQLensObjectContract,
  GQLensSchemaContract,
  GraphDataAddress,
  EntityRef,
  FieldSignal,
  GraphDataStore,
  GraphDataRuntimeStore,
} from "../src/types";

interface TestSchemaField {
  readonly graphQLType?: string | undefined;
  readonly objectKind?: "entity" | "value" | undefined;
  readonly returnsEntity?: boolean | undefined;
  readonly cardinality?: "one" | "list" | undefined;
  readonly isAbstract?: boolean | undefined;
  readonly possibleTypes?: readonly string[] | undefined;
  readonly args?: Readonly<Record<string, string>> | undefined;
}

interface TestSchemaShape {
  readonly roots?: Readonly<Record<string, TestSchemaField>> | undefined;
  readonly mutation?: Readonly<Record<string, TestSchemaField>> | undefined;
  readonly types?: Readonly<Record<string, Readonly<Record<string, TestSchemaField>>>> | undefined;
}

type TestSlotValue = EntityRef | readonly EntityRef[] | readonly string[] | null | undefined;

export function cacheField<T = unknown>(
  cache: GraphDataStore,
  ref: EntityRef,
  key: string,
): FieldSignal<T> {
  return runtimeStore(cache).entry<T>({ owner: { kind: "entity", ref }, path: [{ field: key }] });
}

export function cacheSlot<T = TestSlotValue>(cache: GraphDataStore, key: string): FieldSignal<T> {
  return runtimeStore(cache).entry<T>(slotAddress(key));
}

export function peekCacheField<T = unknown>(
  cache: GraphDataStore,
  ref: EntityRef,
  key: string,
): FieldSignal<T> | undefined {
  return runtimeStore(cache).peek<T>({ owner: { kind: "entity", ref }, path: [{ field: key }] });
}

export function peekCacheSlot<T = TestSlotValue>(
  cache: GraphDataStore,
  key: string,
): FieldSignal<T> | undefined {
  return runtimeStore(cache).peek<T>(slotAddress(key));
}

export function isCacheFieldFresh(cache: GraphDataStore, ref: EntityRef, key: string): boolean {
  return cache.isFresh({ owner: { kind: "entity", ref }, path: [{ field: key }] });
}

export function isCacheSlotFresh(cache: GraphDataStore, key: string): boolean {
  return cache.isFresh(slotAddress(key));
}

function runtimeStore(cache: GraphDataStore): GraphDataRuntimeStore {
  return cache as GraphDataRuntimeStore;
}

export function schemaContract(shape: TestSchemaShape): GQLensSchemaContract {
  return {
    query: objectContract("Query", "root", shape.roots ?? {}),
    ...(shape.mutation ? { mutation: objectContract("Mutation", "root", shape.mutation) } : {}),
    objects: Object.fromEntries(
      Object.entries(shape.types ?? {}).map(([typeName, fields]) => [
        typeName,
        objectContract(typeName, objectKind(fields), fields),
      ]),
    ),
  };
}

function objectContract(
  type: string,
  kind: GQLensObjectContract["kind"],
  fields: Readonly<Record<string, TestSchemaField>>,
): GQLensObjectContract {
  const typename = fields["__typename"];
  return {
    type,
    kind,
    fields: {
      __typename: {
        name: "__typename",
        result: { kind: "scalar", cardinality: "one" },
      },
      ...Object.fromEntries(
        Object.entries(fields)
          .filter(([name]) => name !== "__typename")
          .map(([name, field]) => [name, fieldContract(name, field)]),
      ),
    },
    ...(typename?.possibleTypes
      ? {
          isAbstract: true,
          possibleTypes: typename.possibleTypes,
          typeConditions: typename.possibleTypes,
        }
      : {}),
  };
}

function objectKind(
  fields: Readonly<Record<string, TestSchemaField>>,
): GQLensObjectContract["kind"] {
  void fields;
  return "entity";
}

function fieldContract(name: string, field: TestSchemaField): GQLensFieldContract {
  if (!field.graphQLType) {
    return {
      name,
      result: { kind: "scalar", cardinality: field.cardinality ?? "one" },
      ...(field.args ? { args: field.args } : {}),
    };
  }
  return {
    name,
    result: {
      kind: "object",
      cardinality: field.cardinality ?? "one",
      typeName: field.graphQLType,
      objectKind: field.objectKind ?? (field.returnsEntity === false ? "value" : "entity"),
      ...(field.isAbstract ? { isAbstract: true } : {}),
      ...(field.possibleTypes ? { possibleTypes: field.possibleTypes } : {}),
    },
    ...(field.args ? { args: field.args } : {}),
  };
}

function slotAddress(key: string): GraphDataAddress {
  const { base, facet } = splitFacet(key);
  const entity = /^([^:.]+):([^.]+)\.(.+)$/.exec(base);
  if (entity) {
    return {
      owner: { kind: "entity", ref: { type: entity[1]!, id: entity[2]! } },
      path: [{ field: entity[3]! }],
      facet: facet ?? "link",
    };
  }

  const dot = base.indexOf(".");
  if (dot < 0) {
    return { owner: { kind: "root", root: base }, path: [], facet };
  }
  return {
    owner: { kind: "root", root: base.slice(0, dot) },
    path: [{ field: base.slice(dot + 1) }],
    facet,
  };
}

function splitFacet(key: string): {
  readonly base: string;
  readonly facet?: "ids" | "refs" | undefined;
} {
  if (key.endsWith(".ids")) {
    return { base: key.slice(0, -4), facet: "ids" };
  }
  if (key.endsWith(".refs")) {
    return { base: key.slice(0, -5), facet: "refs" };
  }
  return { base: key };
}

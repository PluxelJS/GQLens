import {
  type GraphQLInputType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLSchema,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isInterfaceType,
  isScalarType,
  isUnionType,
} from "graphql";

export type ObjectKind = "entity" | "value";

export function getEntityTypes(schema: GraphQLSchema): GraphQLObjectType[] {
  return Object.values(schema.getTypeMap()).filter(
    (t): t is GraphQLObjectType =>
      isObjectType(t) &&
      !t.name.startsWith("__") &&
      !["Query", "Mutation", "Subscription"].includes(t.name) &&
      objectKind(t) === "entity",
  );
}

export function objectKind(type: GraphQLObjectType): ObjectKind {
  return hasValidIdField(type) ? "entity" : "value";
}

export function hasValidIdField(type: GraphQLObjectType): boolean {
  const id = type.getFields()["id"];
  return Boolean(id && isNonNullType(id.type) && isScalarType(id.type.ofType));
}

export function validateEntitySchemaContract(schema: GraphQLSchema): void {
  const errors: string[] = [];

  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith("__") || isRootType(type.name)) {
      continue;
    }
    const id = type.getFields()["id"];
    if (id && (!isNonNullType(id.type) || !isScalarType(id.type.ofType))) {
      errors.push(`${type.name}.id must be a non-null scalar field.`);
    }
  }

  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) && !isInterfaceType(type)) {
      continue;
    }
    if (type.name.startsWith("__")) {
      continue;
    }
    for (const field of Object.values(type.getFields())) {
      const named = unwrapOutput(field.type);
      if (!isListTypeLike(field.type) && !isInterfaceType(named) && !isUnionType(named)) {
        continue;
      }
      if (isListTypeLike(field.type) && isObjectType(named) && objectKind(named) === "value") {
        errors.push(`${type.name}.${field.name} returns a list of Value Object ${named.name}.`);
        continue;
      }
      if (isInterfaceType(named) || isUnionType(named)) {
        const valueTypes = schema
          .getPossibleTypes(named)
          .filter((possible) => objectKind(possible) === "value")
          .map((possible) => possible.name);
        if (valueTypes.length > 0) {
          errors.push(
            `${type.name}.${field.name} returns abstract ${named.name} with Value Object possible types: ${valueTypes.join(", ")}.`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid GQLens schema contract:\n${errors.map((item) => `- ${item}`).join("\n")}`,
    );
  }
}

export function outputTsType(type: GraphQLOutputType): string {
  if (isNonNullType(type)) {
    return outputTsType(type.ofType);
  }
  if (isListType(type)) {
    return `(${outputTsType(type.ofType)})[]`;
  }
  if (isScalarType(type)) {
    return scalarMap[type.name] ?? "unknown";
  }
  if (isEnumType(type)) {
    return type.name;
  }
  if (isObjectType(type)) {
    return type.name;
  }
  return "unknown";
}

export function inputTsType(type: GraphQLInputType): string {
  if (isNonNullType(type)) {
    return inputTsType(type.ofType);
  }
  if (isListType(type)) {
    return `(${inputTsType(type.ofType)})[]`;
  }
  if (isScalarType(type)) {
    return scalarMap[type.name] ?? "unknown";
  }
  if (isEnumType(type)) {
    return type.name;
  }
  return "unknown";
}

export function isScalarOrEnum(type: unknown): boolean {
  let t = type;
  if (isNonNullType(t)) {
    t = t.ofType;
  }
  return isScalarType(t) || isEnumType(t);
}

export function unwrapOutput(type: GraphQLOutputType): GraphQLOutputType {
  if (isNonNullType(type)) {
    return unwrapOutput(type.ofType);
  }
  if (isListType(type)) {
    return unwrapOutput(type.ofType);
  }
  return type;
}

export function isListTypeLike(type: unknown): boolean {
  if (isNonNullType(type)) {
    return isListTypeLike(type.ofType);
  }
  return isListType(type);
}

function isRootType(name: string): boolean {
  return name === "Query" || name === "Mutation" || name === "Subscription";
}

const scalarMap: Record<string, string> = {
  String: "string",
  Int: "number",
  Float: "number",
  Boolean: "boolean",
  ID: "string",
};

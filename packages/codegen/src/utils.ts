import {
  type GraphQLInputType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLSchema,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
} from "graphql";

export function getEntityTypes(schema: GraphQLSchema): GraphQLObjectType[] {
  return Object.values(schema.getTypeMap()).filter(
    (t): t is GraphQLObjectType =>
      isObjectType(t) &&
      !t.name.startsWith("__") &&
      !["Query", "Mutation", "Subscription"].includes(t.name),
  );
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

const scalarMap: Record<string, string> = {
  String: "string",
  Int: "number",
  Float: "number",
  Boolean: "boolean",
  ID: "string",
};

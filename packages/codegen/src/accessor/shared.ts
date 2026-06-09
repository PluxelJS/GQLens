import CodeBlockWriter from "code-block-writer";
import {
  type GraphQLField,
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type GraphQLUnionType,
  isEnumType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
} from "graphql";
import { generatedArgsTypeName, generatedTypeName } from "../type-names";
import { isListTypeLike, unwrapOutput } from "../utils";

export function createWriter(): CodeBlockWriter {
  return new CodeBlockWriter({ indentNumberOfSpaces: 2, useSingleQuote: false });
}

export function writeNamedImport(
  writer: CodeBlockWriter,
  moduleName: string,
  names: readonly string[],
  options: { readonly typeOnly?: boolean } = {},
): void {
  writer.writeLine(`${options.typeOnly ? "import type" : "import"} {`);
  writer.indent(() => {
    for (const name of names) {
      writer.writeLine(`${name},`);
    }
  });
  writer.writeLine(`} from ${quote(moduleName)};`);
}

export function writeSection(writer: CodeBlockWriter, title: string): void {
  writer.writeLine(`// ${title}`);
}

export function accessorTypes(
  schema: GraphQLSchema,
): Array<GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType> {
  return Object.values(schema.getTypeMap()).filter(
    (type): type is GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType =>
      (isObjectType(type) || isInterfaceType(type) || isUnionType(type)) &&
      !type.name.startsWith("__") &&
      type.name !== "Mutation" &&
      type.name !== "Subscription",
  );
}

export function generatedEntityTypes(
  schema: GraphQLSchema,
): Array<GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType> {
  return Object.values(schema.getTypeMap()).filter(
    (type): type is GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType =>
      (isObjectType(type) || isInterfaceType(type) || isUnionType(type)) &&
      !type.name.startsWith("__") &&
      !["Query", "Mutation", "Subscription"].includes(type.name),
  );
}

export function objectLiteral(entries: readonly string[]): string {
  if (entries.length === 0) {
    return "{}";
  }
  return `{ ${entries.join(", ")} }`;
}

export function objectEntry(key: string, value: string): string {
  return `${quote(key)}: ${value}`;
}

export function fieldMeta(key: string, parts: readonly string[]): string {
  return `${quote(key)}: { ${parts.join(", ")} }`;
}

export function quote(value: string): string {
  return JSON.stringify(value);
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export { isListTypeLike };

export function isCompositeType(
  type: unknown,
): type is GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType {
  return isObjectType(type) || isInterfaceType(type) || isUnionType(type);
}

export function isAbstractType(type: unknown): boolean {
  return isInterfaceType(type) || isUnionType(type);
}

export function possibleTypeNames(schema: GraphQLSchema, type: GraphQLNamedType): string[] {
  if (isInterfaceType(type) || isUnionType(type)) {
    return schema.getPossibleTypes(type).map((item) => item.name);
  }
  return [];
}

export function typeConditionNames(schema: GraphQLSchema, type: GraphQLNamedType): string[] {
  const possibleTypes = possibleTypeNames(schema, type);
  if (possibleTypes.length === 0) {
    return [];
  }

  const conditions = new Set(possibleTypes);
  for (const candidate of Object.values(schema.getTypeMap())) {
    if (!isInterfaceType(candidate) || candidate.name === type.name) {
      continue;
    }
    const candidateTypes = schema.getPossibleTypes(candidate).map((item) => item.name);
    if (candidateTypes.some((typeName) => possibleTypes.includes(typeName))) {
      conditions.add(candidate.name);
    }
  }
  return [...conditions];
}

export function nodeTypeName(typeName: string): string {
  return `${generatedTypeName(typeName)}Node`;
}

export function argsTypeName(
  owner: GraphQLObjectType | GraphQLInterfaceType | undefined,
  field: GraphQLField<unknown, unknown>,
): string {
  return generatedArgsTypeName(owner?.name ?? "Mutation", field.name);
}

export function isLeafType(type: GraphQLOutputType): boolean {
  const unwrapped = unwrapOutput(type);
  return Boolean(unwrapped && (isScalarType(unwrapped) || isEnumType(unwrapped)));
}

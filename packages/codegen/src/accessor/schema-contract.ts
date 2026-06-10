import type CodeBlockWriter from "code-block-writer";
import {
  type GraphQLField,
  type GraphQLInterfaceType,
  type GraphQLObjectType,
  type GraphQLSchema,
  type GraphQLUnionType,
  isInterfaceType,
  isObjectType,
} from "graphql";
import { objectKind, unwrapOutput } from "../utils";
import {
  fieldContractEntry,
  generatedEntityTypes,
  isCompositeType,
  isListTypeLike,
  json,
  objectEntry,
  objectLiteral,
  possibleTypeNames,
  quote,
  typeConditionNames,
  writeSection,
} from "./shared";

export function writeSchemaContract(writer: CodeBlockWriter, schema: GraphQLSchema): void {
  writeSection(writer, "Schema contract consumed by @gqlens/core");
  writer.writeLine("export const gqlensSchema: GQLensSchemaContract = {");
  writer.indent(() => {
    writeObjectContractProperty(writer, "query", schema.getQueryType(), "Query", schema);
    writeObjectContractProperty(writer, "mutation", schema.getMutationType(), "Mutation", schema);
    writer.writeLine("objects: {");
    writer.indent(() => {
      for (const entity of generatedEntityTypes(schema)) {
        writeObjectContractProperty(writer, quote(entity.name), entity, entity.name, schema);
      }
    });
    writer.writeLine("},");
  });
  writer.writeLine("};");
  writer.blankLine();
}

function writeObjectContractProperty(
  writer: CodeBlockWriter,
  propertyName: string,
  type: GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType | null | undefined,
  fallbackName: string,
  schema: GraphQLSchema,
): void {
  if (!type && propertyName === "mutation") {
    return;
  }
  writer.writeLine(`${propertyName}: {`);
  writer.indent(() => {
    writer.writeLine(`type: ${quote(type?.name ?? fallbackName)},`);
    if (propertyName === "query" || propertyName === "mutation") {
      writer.writeLine(`kind: ${quote("root")},`);
    } else if (type && isObjectType(type)) {
      writer.writeLine(`kind: ${quote(objectKind(type))},`);
    } else {
      writer.writeLine(`kind: ${quote("entity")},`);
    }
    writer.writeLine("fields: {");
    writer.indent(() => {
      for (const field of entityFieldEntriesFor(type, schema)) {
        writer.writeLine(`${field},`);
      }
    });
    writer.writeLine("},");

    if (type) {
      const possibleTypes = possibleTypeNames(schema, type);
      if (possibleTypes.length > 0) {
        writer.writeLine("isAbstract: true,");
        writer.writeLine(`possibleTypes: ${json(possibleTypes)},`);
        writer.writeLine(`typeConditions: ${json(typeConditionNames(schema, type))},`);
      }
    }
  });
  writer.writeLine("},");
}

function entityFieldEntriesFor(
  type: GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType | null | undefined,
  schema: GraphQLSchema,
): string[] {
  if (!type) {
    return [];
  }
  return [
    fieldContractEntry("__typename", [
      `name: ${quote("__typename")}`,
      `result: ${objectLiteral([objectEntry("kind", quote("scalar")), objectEntry("cardinality", quote("one"))])}`,
    ]),
    ...(isObjectType(type) || isInterfaceType(type)
      ? Object.values(type.getFields()).map((field) => entityFieldEntry(field, schema))
      : []),
  ];
}

function entityFieldEntry(field: GraphQLField<unknown, unknown>, schema: GraphQLSchema): string {
  const unwrapped = unwrapOutput(field.type);
  const compositeType = isCompositeType(unwrapped) ? unwrapped : undefined;
  const targetKind =
    compositeType && isObjectType(compositeType) ? objectKind(compositeType) : undefined;
  const possible = compositeType ? possibleTypeNames(schema, compositeType) : [];
  const cardinality = isListTypeLike(field.type) ? "list" : "one";
  const result = compositeType
    ? objectLiteral([
        objectEntry("kind", quote("object")),
        objectEntry("cardinality", quote(cardinality)),
        objectEntry("typeName", quote(compositeType.name)),
        objectEntry("objectKind", quote(targetKind ?? "entity")),
        ...(possible.length > 0
          ? [objectEntry("isAbstract", "true"), objectEntry("possibleTypes", json(possible))]
          : []),
      ])
    : objectLiteral([
        objectEntry("kind", quote("scalar")),
        objectEntry("cardinality", quote(cardinality)),
      ]);
  const parts = [
    `name: ${quote(field.name)}`,
    `result: ${result}`,
    ...(field.args.length > 0
      ? [
          `args: ${objectLiteral(field.args.map((arg) => objectEntry(arg.name, quote(String(arg.type)))))}`,
        ]
      : []),
  ];
  return fieldContractEntry(field.name, parts);
}

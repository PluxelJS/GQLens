import type CodeBlockWriter from "code-block-writer";
import {
  type GraphQLField,
  type GraphQLInterfaceType,
  type GraphQLObjectType,
  type GraphQLSchema,
  type GraphQLUnionType,
  isInterfaceType,
  isObjectType,
  isUnionType,
} from "graphql";
import { objectKind, unwrapOutput } from "../utils";
import {
  fieldMeta,
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

export function writeSchemaMeta(writer: CodeBlockWriter, schema: GraphQLSchema): void {
  writeSection(writer, "Schema metadata consumed by @gqlens/core");
  writer.writeLine("const schemaMeta: SchemaMeta = {");
  writer.indent(() => {
    writeEntityMetaProperty(writer, "query", schema.getQueryType(), "Query", schema);
    writePlannerMeta(writer, schema);
    writer.writeLine("entities: {");
    writer.indent(() => {
      for (const entity of generatedEntityTypes(schema)) {
        writeEntityMetaProperty(writer, quote(entity.name), entity, entity.name, schema);
      }
    });
    writer.writeLine("},");
  });
  writer.writeLine("};");
  writer.blankLine();
}

function writePlannerMeta(writer: CodeBlockWriter, schema: GraphQLSchema): void {
  const query = schema.getQueryType();
  const types = Object.values(schema.getTypeMap()).filter(
    (type): type is GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType =>
      (isObjectType(type) || isInterfaceType(type) || isUnionType(type)) &&
      !type.name.startsWith("__"),
  );

  writer.writeLine("planner: {");
  writer.indent(() => {
    writePlannerFieldMapProperty(writer, "roots", query, schema);
    writer.writeLine("types: {");
    writer.indent(() => {
      for (const type of types) {
        writePlannerFieldMapProperty(writer, quote(type.name), type, schema);
      }
    });
    writer.writeLine("},");
  });
  writer.writeLine("},");
}

function writePlannerFieldMapProperty(
  writer: CodeBlockWriter,
  propertyName: string,
  type: GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType | null | undefined,
  schema: GraphQLSchema,
): void {
  writer.writeLine(`${propertyName}: {`);
  writer.indent(() => {
    for (const field of plannerFieldEntriesFor(type, schema)) {
      writer.writeLine(`${field},`);
    }
  });
  writer.writeLine("},");
}

function plannerFieldEntriesFor(
  type: GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType | null | undefined,
  schema: GraphQLSchema,
): string[] {
  if (!type) {
    return [];
  }
  const possibleTypes = possibleTypeNames(schema, type);
  if (isUnionType(type)) {
    return [typenamePlannerMeta(possibleTypes)];
  }
  if (!isObjectType(type) && !isInterfaceType(type)) {
    return [typenamePlannerMeta(possibleTypes)];
  }

  return [
    ...(possibleTypes.length > 0
      ? [typenamePlannerMeta(possibleTypes)]
      : [fieldMeta("__typename", ["returnsEntity: false"])]),
    ...Object.values(type.getFields()).map((field) => plannerFieldEntry(field, schema)),
  ];
}

function plannerFieldEntry(field: GraphQLField<unknown, unknown>, schema: GraphQLSchema): string {
  const unwrapped = unwrapOutput(field.type);
  const objectType = isCompositeType(unwrapped) ? unwrapped : undefined;
  const targetKind = objectType && isObjectType(objectType) ? objectKind(objectType) : undefined;
  const returnsEntity = objectType ? targetKind !== "value" : false;
  const parts = [`returnsEntity: ${JSON.stringify(returnsEntity)}`];
  if (objectType) {
    parts.push(`graphQLType: ${quote(objectType.name)}`);
    if (targetKind) {
      parts.push(`targetObjectKind: ${quote(targetKind)}`);
    }
    const possible = possibleTypeNames(schema, objectType);
    if (possible.length > 0) {
      parts.push("isAbstract: true");
      parts.push(`possibleTypes: ${json(possible)}`);
    }
  }
  if (isListTypeLike(field.type)) {
    parts.push("returnsList: true");
  }
  if (field.args.length > 0) {
    parts.push(
      `args: ${objectLiteral(field.args.map((arg) => objectEntry(arg.name, quote(String(arg.type)))))}`,
    );
  }
  return fieldMeta(field.name, parts);
}

function typenamePlannerMeta(possibleTypes: readonly string[]): string {
  return fieldMeta("__typename", [
    "returnsEntity: false",
    ...(possibleTypes.length > 0 ? [`possibleTypes: ${json(possibleTypes)}`] : []),
  ]);
}

function writeEntityMetaProperty(
  writer: CodeBlockWriter,
  propertyName: string,
  type: GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType | null | undefined,
  fallbackName: string,
  schema: GraphQLSchema,
): void {
  writer.writeLine(`${propertyName}: {`);
  writer.indent(() => {
    writer.writeLine(`type: ${quote(type?.name ?? fallbackName)},`);
    if (propertyName === "query") {
      writer.writeLine(`kind: ${quote("root")},`);
    } else if (type && isObjectType(type)) {
      writer.writeLine(`kind: ${quote(objectKind(type))},`);
    } else {
      writer.writeLine(`kind: ${quote("entity")},`);
    }
    writer.writeLine(
      propertyName === "query" || (type && isObjectType(type) && objectKind(type) === "value")
        ? "identityKeys: [],"
        : 'identityKeys: ["id", "__typename"],',
    );
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
    fieldMeta("__typename", [`name: ${quote("__typename")}`, `kind: ${quote("scalar")}`]),
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
  const kind =
    isListTypeLike(field.type) && compositeType
      ? "list"
      : compositeType && targetKind === "value"
        ? "value"
        : compositeType
          ? "entity"
          : "scalar";
  const possible = compositeType ? possibleTypeNames(schema, compositeType) : [];
  const parts = [
    `name: ${quote(field.name)}`,
    `kind: ${quote(kind)}`,
    ...(compositeType ? [`typeName: ${quote(compositeType.name)}`] : []),
    ...(targetKind ? [`targetObjectKind: ${quote(targetKind)}`] : []),
    ...(possible.length > 0 ? ["isAbstract: true", `possibleTypes: ${json(possible)}`] : []),
    ...(field.args.length > 0 ? ["hasArgs: true"] : []),
  ];
  return fieldMeta(field.name, parts);
}

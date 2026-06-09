import type CodeBlockWriter from "code-block-writer";
import {
  type GraphQLField,
  type GraphQLInterfaceType,
  type GraphQLObjectType,
  type GraphQLSchema,
  isInterfaceType,
  isNonNullType,
  isObjectType,
} from "graphql";
import { generatedTypeName } from "../type-names";
import { unwrapOutput } from "../utils";
import {
  accessorTypes,
  argsTypeName,
  isAbstractType,
  isCompositeType,
  isListTypeLike,
  nodeTypeName,
  quote,
  typeConditionNames,
  writeSection,
} from "./shared";

export function writeNodeInterfaces(writer: CodeBlockWriter, schema: GraphQLSchema): void {
  writeSection(writer, "Typed accessor nodes");
  for (const type of accessorTypes(schema)) {
    writer.write(`export interface ${nodeTypeName(type.name)} `).block(() => {
      writer.writeLine("readonly __typename: string | undefined;");

      if (isObjectType(type) || isInterfaceType(type)) {
        for (const field of Object.values(type.getFields())) {
          writer.writeLine(`readonly ${fieldSignature(type, field)};`);
        }
      }

      const typeConditions = typeConditionNames(schema, type);
      if (typeConditions.length > 0) {
        writer.writeLine("readonly $on: {");
        writer.indent(() => {
          for (const typeName of typeConditions) {
            writer.writeLine(`readonly ${typeName}: ${nodeTypeName(typeName)};`);
          }
        });
        writer.writeLine("};");
      }
    });
    writer.blankLine();
  }
}

function fieldSignature(
  owner: GraphQLObjectType | GraphQLInterfaceType,
  field: GraphQLField<unknown, unknown>,
): string {
  const returnType = nodeReturnType(owner, field);
  if (field.args.length === 0) {
    return `${field.name}: ${returnType}`;
  }
  const optional = field.args.every((arg) => !isNonNullType(arg.type)) ? "?" : "";
  return `${field.name}: (args${optional}: GQLensArgs<Types.${argsTypeName(owner, field)}>) => ${returnType}`;
}

function nodeReturnType(
  owner: GraphQLObjectType | GraphQLInterfaceType,
  field: GraphQLField<unknown, unknown>,
): string {
  const unwrapped = unwrapOutput(field.type);
  if (isListTypeLike(field.type) && isCompositeType(unwrapped)) {
    if (isAbstractType(unwrapped)) {
      return "{ readonly refs: readonly EntityRef[] | undefined }";
    }
    return "{ readonly ids: readonly string[] | undefined }";
  }
  if (isCompositeType(unwrapped)) {
    return nodeTypeName(unwrapped.name);
  }
  return `Types.${generatedTypeName(owner.name)}[${quote(field.name)}] | undefined`;
}

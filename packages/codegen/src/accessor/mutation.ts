import type CodeBlockWriter from "code-block-writer";
import { type GraphQLField, type GraphQLObjectType, isObjectType } from "graphql";
import { generatedArgsTypeName, generatedTypeName } from "../type-names";
import { objectKind, unwrapOutput } from "../utils";
import { isLeafType, quote, writeSection } from "./shared";

export function writeMutationApi(writer: CodeBlockWriter, type: GraphQLObjectType): void {
  writeSection(writer, "Mutation operation descriptors");
  const groups = mutationGroups(type);

  writer.writeLine("export const api: {");
  writer.indent(() => {
    for (const [group, fields] of groups) {
      writer.writeLine(`readonly ${group}: {`);
      writer.indent(() => {
        for (const field of fields) {
          const { action } = mutationApiName(field.name);
          writer.writeLine(`readonly ${action}: ${mutationOperationType(field)};`);
        }
      });
      writer.writeLine("};");
    }
  });
  writer.writeLine("} = {");
  writer.indent(() => {
    for (const [group, fields] of groups) {
      writer.writeLine(`${group}: {`);
      writer.indent(() => {
        for (const field of fields) {
          const { action } = mutationApiName(field.name);
          writeMutationOperation(writer, action, field);
        }
      });
      writer.writeLine("},");
    }
  });
  writer.writeLine("};");
}

function mutationGroups(
  type: GraphQLObjectType,
): Array<[string, GraphQLField<unknown, unknown>[]]> {
  const groups = new Map<string, GraphQLField<unknown, unknown>[]>();
  for (const field of Object.values(type.getFields())) {
    const { group } = mutationApiName(field.name);
    const fields = groups.get(group) ?? [];
    fields.push(field);
    groups.set(group, fields);
  }
  return [...groups.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([group, fields]) => [
      group,
      fields.toSorted((a, b) =>
        mutationApiName(a.name).action.localeCompare(mutationApiName(b.name).action),
      ),
    ]);
}

function writeMutationOperation(
  writer: CodeBlockWriter,
  action: string,
  field: GraphQLField<unknown, unknown>,
): void {
  const argsType = mutationArgsType(field);
  writer.writeLine(`${action}: {`);
  writer.indent(() => {
    writer.writeLine(`operationName: ${quote(field.name)},`);
    writer.writeLine(`query: ${quote(mutationQuery(field))},`);
    writer.writeLine("schema: gqlensSchema,");
    writeMutationVariables(writer, field, argsType);
  });
  writer.writeLine("},");
}

function mutationOperationType(field: GraphQLField<unknown, unknown>): string {
  return `MutationOperation<${mutationArgsType(field)}, ${apiReturnType(field)}>`;
}

function writeMutationVariables(
  writer: CodeBlockWriter,
  field: GraphQLField<unknown, unknown>,
  argsType: string,
): void {
  if (field.args.length === 0) {
    writer.writeLine(`variables: (input: ${argsType}): Record<string, unknown> => {`);
    writer.indent(() => {
      writer.writeLine("void input;");
      writer.writeLine("return {};");
    });
    writer.writeLine("},");
    return;
  }

  writer.writeLine(`variables: (input: ${argsType}): Record<string, unknown> => ({`);
  writer.indent(() => {
    for (const arg of field.args) {
      writer.writeLine(`${arg.name}: input.${arg.name},`);
    }
  });
  writer.writeLine("}),");
}

function mutationArgsType(field: GraphQLField<unknown, unknown>): string {
  const argsType =
    field.args.length > 0
      ? `Types.${generatedArgsTypeName("Mutation", field.name)}`
      : "Record<string, unknown>";
  return argsType;
}

function mutationQuery(field: GraphQLField<unknown, unknown>): string {
  const declarations = field.args.map((arg) => `$${arg.name}: ${String(arg.type)}`).join(", ");
  const args = field.args.map((arg) => `${arg.name}: $${arg.name}`).join(", ");
  const selection = mutationSelection(field);
  const header = declarations
    ? `mutation ${field.name}(${declarations})`
    : `mutation ${field.name}`;
  const call = args ? `${field.name}(${args})` : field.name;
  return selection ? `${header} { ${call} { ${selection} } }` : `${header} { ${call} }`;
}

function mutationSelection(field: GraphQLField<unknown, unknown>): string {
  const unwrapped = unwrapOutput(field.type);
  if (!unwrapped || !isObjectType(unwrapped)) {
    return "";
  }
  return mutationSelectedFieldNames(field).join(" ");
}

function apiReturnType(field: GraphQLField<unknown, unknown>): string {
  const unwrapped = unwrapOutput(field.type);
  if (unwrapped && isObjectType(unwrapped)) {
    const fields = mutationSelectedFieldNames(field)
      .map((name) => quote(name))
      .join(" | ");
    return `Pick<NonNullable<Types.Mutation[${quote(field.name)}]>, ${fields}>`;
  }
  return `Types.${generatedTypeName("Mutation")}[${quote(field.name)}]`;
}

function mutationSelectedFieldNames(field: GraphQLField<unknown, unknown>): string[] {
  const unwrapped = unwrapOutput(field.type);
  if (!unwrapped || !isObjectType(unwrapped)) {
    return [];
  }
  const fields = Object.values(unwrapped.getFields())
    .filter((item) => isLeafType(item.type))
    .map((item) => item.name);
  const identity = objectKind(unwrapped) === "entity" ? ["id", "__typename"] : ["__typename"];
  return [...new Set([...identity, ...fields])];
}

function mutationApiName(fieldName: string): { group: string; action: string } {
  const match = /^(add|create|delete|remove|rename|set|toggle|update)([A-Z].*)$/.exec(fieldName);
  if (!match) {
    return { group: "mutation", action: fieldName };
  }

  return {
    group: lowerFirst(match[2]!),
    action: match[1]!,
  };
}

function lowerFirst(value: string): string {
  return `${value.slice(0, 1).toLowerCase()}${value.slice(1)}`;
}

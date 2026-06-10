import type { GQLensFieldContract, GQLensObjectContract, GQLensSchemaContract } from "./types";

export function rootContract(
  schema: GQLensSchemaContract | undefined,
  operationType: string,
): GQLensObjectContract | undefined {
  if (!schema) {
    return undefined;
  }
  return operationType === "mutation" ? schema.mutation : schema.query;
}

export function rootFieldContract(
  schema: GQLensSchemaContract | undefined,
  operationType: string,
  fieldName: string,
): GQLensFieldContract | undefined {
  return rootContract(schema, operationType)?.fields[fieldName];
}

export function queryFieldContract(
  schema: GQLensSchemaContract | undefined,
  fieldName: string,
): GQLensFieldContract | undefined {
  return schema?.query.fields[fieldName];
}

export function objectContract(
  schema: GQLensSchemaContract | undefined,
  typeName: string | undefined,
): GQLensObjectContract | undefined {
  return typeName ? schema?.objects[typeName] : undefined;
}

export function objectFieldContract(
  schema: GQLensSchemaContract | undefined,
  typeName: string | undefined,
  fieldName: string,
): GQLensFieldContract | undefined {
  return objectContract(schema, typeName)?.fields[fieldName];
}

export function fieldTypeName(field: GQLensFieldContract | undefined): string | undefined {
  return field?.result.kind === "object" ? field.result.typeName : undefined;
}

export function fieldObjectKind(
  field: GQLensFieldContract | undefined,
): "entity" | "value" | undefined {
  return field?.result.kind === "object" ? field.result.objectKind : undefined;
}

export function fieldReturnsList(field: GQLensFieldContract | undefined): boolean {
  return field?.result.cardinality === "list";
}

export function fieldReturnsEntity(field: GQLensFieldContract | undefined): boolean {
  return field?.result.kind === "object" && field.result.objectKind === "entity";
}

export function fieldPossibleTypes(
  field: GQLensFieldContract | undefined,
): readonly string[] | undefined {
  return field?.result.kind === "object" ? field.result.possibleTypes : undefined;
}

export function fieldIsAbstract(field: GQLensFieldContract | undefined): boolean {
  return field?.result.kind === "object" && field.result.isAbstract === true;
}

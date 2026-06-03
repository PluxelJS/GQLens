import { convertFactory } from "@graphql-codegen/visitor-plugin-common";

export const typescriptPluginConfig = {
  enumsAsTypes: true,
} as const;

const convertName = convertFactory({});

export function generatedTypeName(name: string): string {
  return convertName(name);
}

export function generatedArgsTypeName(ownerName: string, fieldName: string): string {
  return `${generatedTypeName(ownerName)}${generatedTypeName(fieldName)}Args`;
}

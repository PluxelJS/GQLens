import type CodeBlockWriter from "code-block-writer";
import type { GraphQLObjectType } from "graphql";
import { nodeTypeName, quote, writeSection } from "./shared";

export interface RuntimeEntrypoint {
  readonly type: GraphQLObjectType;
  readonly exportName: string;
  readonly sessionHook: string;
}

interface RuntimeAccessorShape {
  readonly type: GraphQLObjectType;
  readonly nodeName: string;
  readonly resultType: string;
}

export function writeQueryHook(writer: CodeBlockWriter, entrypoint: RuntimeEntrypoint): void {
  writeSection(writer, `${entrypoint.exportName} runtime entrypoint`);
  const shape = runtimeAccessorShape(entrypoint.type);

  writer
    .write(
      `export function ${entrypoint.exportName}(config?: GQLensQueryOptions): ${shape.resultType} `,
    )
    .block(() => {
      writer.writeLine(
        `const state = ${entrypoint.sessionHook}({ ...config, schema: gqlensSchema });`,
      );
      writeAccessorCreation(writer, shape);
    });
  writer.blankLine();
}

export function writePreparedQueryHook(
  writer: CodeBlockWriter,
  entrypoint: RuntimeEntrypoint,
): void {
  writeSection(writer, `${entrypoint.exportName} prepared runtime entrypoint`);
  const shape = runtimeAccessorShape(entrypoint.type);

  writer
    .write(
      `export function ${entrypoint.exportName}(selection: PreparedSelection, variables: Readonly<Record<string, unknown>>, config?: GQLensQueryOptions): ${shape.resultType} `,
    )
    .block(() => {
      writer.writeLine(
        `const state = ${entrypoint.sessionHook}({ ...config, schema: gqlensSchema });`,
      );
      writer.writeLine("for (const path of bindGQLensSelection(selection, variables)) {");
      writer.indent(() => {
        writer.writeLine("state.demand(path.root, path.steps);");
      });
      writer.writeLine("}");
      writeAccessorCreation(writer, shape);
    });
  writer.blankLine();
}

export function writeSelectorBuilders(writer: CodeBlockWriter, type: GraphQLObjectType): void {
  writeSection(writer, "Static selector builders");
  const nodeName = nodeTypeName(type.name);

  writer
    .write(
      `export function defineSelection(callback: (q: ${nodeName}, v: (name: string) => VariablePlaceholder) => void): PreparedSelection `,
    )
    .block(() => {
      writer.writeLine(
        `return defineGQLensSelection<${nodeName}>(gqlensSchema, gqlensSchema.query, callback);`,
      );
    });
  writer.blankLine();

  writer
    .write(
      `export function defineInvalidation(callback: (q: ${nodeName}) => unknown): GraphDataInvalidation `,
    )
    .block(() => {
      writer.writeLine(
        `return defineGQLensInvalidation<${nodeName}>(gqlensSchema, gqlensSchema.query, callback);`,
      );
    });
  writer.blankLine();
}

function runtimeAccessorShape(type: GraphQLObjectType): RuntimeAccessorShape {
  const nodeName = nodeTypeName(type.name);
  return {
    type,
    nodeName,
    resultType: `${nodeName} & { readonly loading: boolean; readonly error: Error | null; readonly refetch: () => void }`,
  };
}

function writeAccessorCreation(writer: CodeBlockWriter, shape: RuntimeAccessorShape): void {
  writer.writeLine("const ctx: AccessorContext = {");
  writer.indent(() => {
    writer.writeLine(`root: ${quote(shape.type.name)},`);
    writer.writeLine("store: state.store,");
    writer.writeLine(`demand: (steps) => state.demand(${quote(shape.type.name)}, steps),`);
    writer.writeLine("read: state.read,");
  });
  writer.writeLine("};");
  writer.writeLine(
    `const accessor = createAccessorNode<${shape.nodeName}>(ctx, gqlensSchema, gqlensSchema.query) as ${shape.resultType};`,
  );
  writer.writeLine("Object.defineProperties(accessor, {");
  writer.indent(() => {
    writer.writeLine("loading: { enumerable: true, get: () => state.loading },");
    writer.writeLine("error: { enumerable: true, get: () => state.error },");
    writer.writeLine("refetch: { enumerable: true, value: () => state.session.refetch() },");
  });
  writer.writeLine("});");
  writer.writeLine("return accessor;");
}

import type { GraphQLSchema } from "graphql";
import type { AccessorAdapter } from "../adapters";
import { createWriter } from "./shared";
import { writeHeader } from "./header";
import { writeSchemaContract } from "./schema-contract";
import { writeMutationApi } from "./mutation";
import { writeNodeInterfaces } from "./nodes";
import { writePreparedQueryHook, writeQueryHook, writeSelectorBuilders } from "./runtime";

export function generateAccessor(schema: GraphQLSchema, adapter: AccessorAdapter): string {
  const writer = createWriter();
  const queryType = schema.getQueryType();
  const mutationType = schema.getMutationType();

  writeHeader(writer, schema, adapter);
  writeNodeInterfaces(writer, schema);
  writeSchemaContract(writer, schema);

  if (queryType) {
    writeQueryHook(writer, {
      type: queryType,
      exportName: adapter.queryExport,
      sessionHook: adapter.querySessionHook,
    });
    writeQueryHook(writer, {
      type: queryType,
      exportName: adapter.liveQueryExport,
      sessionHook: adapter.liveSessionHook,
    });
    writePreparedQueryHook(writer, {
      type: queryType,
      exportName: adapter.preparedQueryExport ?? "usePreparedQuery",
      sessionHook: adapter.querySessionHook,
    });
    writeSelectorBuilders(writer, queryType);
  }

  if (mutationType) {
    writeMutationApi(writer, mutationType);
  }

  return `${writer.toString().trimEnd()}\n`;
}

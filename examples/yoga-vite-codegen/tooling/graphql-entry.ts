import type { IncomingMessage, ServerResponse } from "node:http";
import type { GraphQLSchema } from "graphql";

export type MaybePromise<T> = T | Promise<T>;

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>;

export type GraphQLSchemaSource = string | GraphQLSchema;

export interface GraphQLPluginContext {
  importModule<T = unknown>(id: string): Promise<T>;
}

export interface GraphQLPluginEntry {
  readonly schema: () => MaybePromise<GraphQLSchemaSource>;
  readonly handler?: ((context: GraphQLPluginContext) => MaybePromise<NodeHandler>) | undefined;
}

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GraphQLSchema } from "graphql";
import type { ViteDevServer } from "vite";

export type MaybePromise<T> = T | Promise<T>;

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>;

export type GraphQLSchemaSource = string | GraphQLSchema;

export interface GraphQLPluginEntry {
  readonly schema: () => MaybePromise<GraphQLSchemaSource>;
  readonly handler?: ((server: ViteDevServer) => MaybePromise<NodeHandler>) | undefined;
}

export function defineGraphQLEntry<const T extends GraphQLPluginEntry>(entry: T): T {
  return entry;
}

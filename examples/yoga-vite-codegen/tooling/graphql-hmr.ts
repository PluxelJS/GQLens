import type { IncomingMessage, ServerResponse } from "node:http";
import type { GraphQLSchema } from "graphql";
import type { ViteDevServer } from "vite";

export type MaybePromise<T> = T | Promise<T>;

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>;

export type GraphQLSchemaSource = string | GraphQLSchema;

export interface GraphQLCodegenPluginContext {
  readonly server: ViteDevServer;
  importModule<T = unknown>(id: string): Promise<T>;
}

export interface GraphQLHMRDefinition {
  readonly schema: (context: GraphQLCodegenPluginContext) => MaybePromise<GraphQLSchemaSource>;
  readonly buildSchema: () => MaybePromise<GraphQLSchemaSource>;
  readonly handler?:
    | ((context: GraphQLCodegenPluginContext) => MaybePromise<NodeHandler>)
    | undefined;
}

export function defineGraphQLHMR<const T extends GraphQLHMRDefinition>(definition: T): T {
  return definition;
}

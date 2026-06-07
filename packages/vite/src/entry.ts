import type { IncomingMessage, ServerResponse } from "node:http";

export type MaybePromise<T> = T | Promise<T>;

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>;

export interface GQLensViteServer {
  ssrLoadModule(url: string): Promise<unknown>;
}

export interface GQLensViteEntry {
  readonly schema: () => MaybePromise<string>;
  readonly handler?: ((server: GQLensViteServer) => MaybePromise<NodeHandler>) | undefined;
}

export function defineGQLensEntry(entry: GQLensViteEntry): GQLensViteEntry {
  return entry;
}

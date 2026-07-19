import type { GraphQLOperation, GraphQLResult } from "./types";
import { isRecord } from "./guards";
import { GQLensError } from "./error";

export interface FetcherContext {
  /** Signal owned by the operation's session or mutation caller. */
  readonly signal?: AbortSignal | undefined;
}

export type Fetcher = (op: GraphQLOperation, context?: FetcherContext) => Promise<unknown>;
export type LiveSubscriber = (
  op: GraphQLOperation,
  onData: (data: unknown) => void,
  onError?: ((error: Error) => void) | undefined,
) => () => void;

export function readGraphQLData(data: unknown): GraphQLResult {
  if (isRecord(data) && "data" in data && isRecord(data["data"])) {
    return data["data"];
  }
  return (data ?? {}) as GraphQLResult;
}

interface LiveSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
}

type LiveSocketConstructor = new (endpoint: string) => LiveSocket;

export function createFetchTransport(endpoint: string): Fetcher {
  return async (op: GraphQLOperation, context?: FetcherContext): Promise<unknown> => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: op.query,
        variables: op.variables,
        operationName: op.operationName,
      }),
      ...(context?.signal ? { signal: context.signal } : {}),
    });

    if (!response.ok) {
      throw new GQLensError({
        code: "GRAPHQL_REQUEST_FAILED",
        message: `GraphQL request failed: ${response.status} ${response.statusText}`,
        details: { status: response.status, statusText: response.statusText },
      });
    }

    const json = (await response.json()) as {
      readonly data?: unknown;
      readonly errors?: readonly unknown[];
    };
    if (json.errors && json.errors.length > 0) {
      throw new GQLensError({
        code: "GRAPHQL_RESPONSE_ERRORS",
        message: "GraphQL response contains errors.",
        details: { errors: json.errors },
      });
    }
    return json.data ?? {};
  };
}

export function createLiveTransport(endpoint: string): [LiveSubscriber, () => void] {
  let socket: LiveSocket | null = null;
  let open = false;
  const pending: Array<{ readonly id: string; readonly payload: string }> = [];
  const listeners = new Map<string, (data: unknown) => void>();
  const errorListeners = new Map<string, (error: Error) => void>();
  let nextId = 0;

  function subscribe(
    op: GraphQLOperation,
    onData: (data: unknown) => void,
    onError?: (error: Error) => void,
  ): () => void {
    const id = `gqlens:${nextId++}`;
    listeners.set(id, onData);
    if (onError) {
      errorListeners.set(id, onError);
    }
    const payload = JSON.stringify({ id, type: "subscribe", payload: op });
    if (socket && open) {
      socket.send(payload);
      return () => unsubscribe(id);
    }

    pending.push({ id, payload });
    if (socket) {
      return () => unsubscribe(id);
    }

    const ctor = (globalThis as { readonly WebSocket?: LiveSocketConstructor }).WebSocket;
    if (!ctor) {
      throw new GQLensError({
        code: "WEBSOCKET_UNAVAILABLE",
        message: "WebSocket is not available in this runtime.",
      });
    }

    socket = new ctor(endpoint);
    socket.addEventListener("open", () => {
      open = true;
      for (const item of pending.splice(0)) {
        socket?.send(item.payload);
      }
    });
    socket.addEventListener("message", (event) => {
      const message = parseMessage(event.data);
      if (message.type === "next") {
        const listener = message.id ? listeners.get(message.id) : undefined;
        if (listener) {
          listener(message.payload ?? {});
          return;
        }
        for (const item of listeners.values()) {
          item(message.payload ?? {});
        }
      }
      if (message.type === "error") {
        const error = new GQLensError({
          code: "LIVE_QUERY_ERROR",
          message: "Live query transport reported an error.",
          details: { payload: message.payload },
        });
        const listener = message.id ? errorListeners.get(message.id) : undefined;
        if (listener) {
          listener(error);
          return;
        }
        for (const item of errorListeners.values()) {
          item(error);
        }
      }
    });

    return () => unsubscribe(id);
  }

  function close(): void {
    socket?.close();
    socket = null;
    open = false;
    pending.splice(0);
    listeners.clear();
    errorListeners.clear();
  }

  function unsubscribe(id: string): void {
    listeners.delete(id);
    errorListeners.delete(id);
    const pendingIndex = pending.findIndex((item) => item.id === id);
    if (pendingIndex >= 0) {
      pending.splice(pendingIndex, 1);
    }
    if (socket && open) {
      socket.send(JSON.stringify({ id, type: "unsubscribe" }));
    }
  }

  return [subscribe, close];
}

function parseMessage(data: unknown): {
  readonly id?: string | undefined;
  readonly type?: string | undefined;
  readonly payload?: unknown;
} {
  try {
    return JSON.parse(String(data)) as {
      readonly id?: string;
      readonly type?: string;
      readonly payload?: unknown;
    };
  } catch {
    return { type: "error", payload: "Invalid live message" };
  }
}

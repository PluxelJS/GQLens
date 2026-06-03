import type { GraphQLOperation } from "./types";

export type Fetcher = (op: GraphQLOperation) => Promise<unknown>;
export type LiveSubscriber = (
  op: GraphQLOperation,
  onData: (data: unknown) => void,
  onError?: ((error: Error) => void) | undefined,
) => () => void;

interface LiveSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
}

type LiveSocketConstructor = new (endpoint: string) => LiveSocket;

export function createFetchTransport(endpoint: string): Fetcher {
  return async (op: GraphQLOperation): Promise<unknown> => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: op.query,
        variables: op.variables,
        operationName: op.operationName,
      }),
    });

    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as {
      readonly data?: unknown;
      readonly errors?: readonly unknown[];
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
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
      throw new Error("WebSocket is not available in this runtime");
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
        const error = new Error(JSON.stringify(message.payload ?? "Live query error"));
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

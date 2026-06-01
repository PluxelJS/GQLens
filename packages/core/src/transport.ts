import type { GraphQLOperation } from "./types";

export type Fetcher = (op: GraphQLOperation) => Promise<unknown>;

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

export function createLiveTransport(
  endpoint: string,
): [(op: GraphQLOperation, onData: (data: unknown) => void) => void, () => void] {
  let socket: LiveSocket | null = null;
  let open = false;
  const pending: string[] = [];
  const listeners = new Map<string, (data: unknown) => void>();
  let nextId = 0;

  function subscribe(op: GraphQLOperation, onData: (data: unknown) => void): void {
    const id = `gqlens:${nextId++}`;
    listeners.set(id, onData);
    const payload = JSON.stringify({ id, type: "subscribe", payload: op });
    if (socket && open) {
      socket.send(payload);
      return;
    }

    pending.push(payload);
    if (socket) {
      return;
    }

    const ctor = (globalThis as { readonly WebSocket?: LiveSocketConstructor }).WebSocket;
    if (!ctor) {
      throw new Error("WebSocket is not available in this runtime");
    }

    socket = new ctor(endpoint);
    socket.addEventListener("open", () => {
      open = true;
      for (const item of pending.splice(0)) {
        socket?.send(item);
      }
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        readonly id?: string;
        readonly type?: string;
        readonly payload?: unknown;
      };
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
    });
  }

  function close(): void {
    socket?.close();
    socket = null;
    open = false;
    pending.splice(0);
    listeners.clear();
  }

  return [subscribe, close];
}

import type { GQLensSchemaContract, QuerySession, QuerySessionConfig } from "@gqlens/core";

export interface SessionRequest extends QuerySessionConfig {
  readonly scope: string;
}

export interface SessionLease {
  readonly session: QuerySession;
  release(): void;
}

export interface SessionRegistry {
  acquire(config: SessionRequest): SessionLease;
  values(): Iterable<QuerySession>;
}

let nextSchemaId = 0;
const schemaIds = new WeakMap<GQLensSchemaContract, number>();

export function createSessionRegistry(
  createSession: (config: QuerySessionConfig) => QuerySession,
): SessionRegistry {
  const entries = new Map<string, { readonly session: QuerySession; refs: number }>();

  return {
    acquire(config: SessionRequest): SessionLease {
      const key = sessionKey(config);
      let entry = entries.get(key);
      if (!entry) {
        entry = { session: createSession(querySessionConfig(config)), refs: 0 };
        entries.set(key, entry);
      }
      entry.refs += 1;

      let released = false;
      return {
        session: entry.session,
        release(): void {
          if (released) {
            return;
          }
          released = true;
          entry.refs -= 1;
          if (entry.refs === 0) {
            entries.delete(key);
          }
        },
      };
    },

    values(): Iterable<QuerySession> {
      return [...entries.values()].map((entry) => entry.session);
    },
  };
}

function sessionKey(config: SessionRequest): string {
  return `${config.policy ?? ""}:${config.ttl ?? ""}:${schemaId(config.schema)}:${config.scope}`;
}

function querySessionConfig(config: QuerySessionConfig): QuerySessionConfig {
  return {
    policy: config.policy,
    ttl: config.ttl,
    schema: config.schema,
  };
}

function schemaId(schema: GQLensSchemaContract | undefined): number {
  if (!schema) {
    return 0;
  }
  const existing = schemaIds.get(schema);
  if (existing) {
    return existing;
  }
  const id = ++nextSchemaId;
  schemaIds.set(schema, id);
  return id;
}

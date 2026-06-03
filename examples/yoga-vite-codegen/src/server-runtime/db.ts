interface ExampleDb {
  readonly startedAt: number;
}

declare global {
  var __gqlens_example_db__: ExampleDb | undefined;
}

const existing = globalThis.__gqlens_example_db__;

export const db: ExampleDb = existing ?? {
  startedAt: Date.now(),
};

if (process.env.NODE_ENV !== "production") {
  globalThis.__gqlens_example_db__ = db;
}

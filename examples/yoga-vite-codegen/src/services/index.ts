import type { db } from "../server-runtime/db";

export function createServices(database: typeof db) {
  return {
    health() {
      return {
        dbStartedAt: database.startedAt,
      };
    },
  };
}

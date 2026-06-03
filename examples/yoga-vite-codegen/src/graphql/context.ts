import type { YogaInitialContext } from "graphql-yoga";

import { db } from "../server-runtime/db";
import { createServices } from "../services";

export interface AppContext {
  readonly request: Request;
  readonly db: typeof db;
  readonly services: ReturnType<typeof createServices>;
  readonly user: { readonly id: string; readonly role: string } | null;
}

async function authFromRequest(request: Request): Promise<AppContext["user"]> {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return null;
  }

  return {
    id: "dev-user",
    role: "admin",
  };
}

export async function createAppContext(initial: YogaInitialContext): Promise<AppContext> {
  return {
    request: initial.request,
    db,
    services: createServices(db),
    user: await authFromRequest(initial.request),
  };
}

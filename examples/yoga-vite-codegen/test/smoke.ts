import { createHttpApp } from "../src/http-app";
import { createYogaHandler } from "../src/yoga";
import { api } from "../web/gqlens/accessor";

interface GraphQLPayload<T> {
  readonly data?: T | undefined;
  readonly errors?: readonly { readonly message?: string }[] | undefined;
}

const yoga = createYogaHandler();
const app = createHttpApp();

const health = await app.handle(new Request("http://example.test/health"));
assertEqual(health.status, 200, "Elysia health endpoint is mounted");

const mounted = await graphqlViaApp<{
  readonly viewer: { readonly name: string };
}>({
  query: /* GraphQL */ `
    query MountedGraphQL {
      viewer {
        name
      }
    }
  `,
});

assertEqual(mounted.viewer.name, "Ada Lovelace", "Elysia app mounts Yoga on /graphql");

const graphiql = await app.handle(
  new Request("http://example.test/graphql", {
    headers: { accept: "text/html" },
  }),
);
assertEqual(graphiql.status, 200, "GraphiQL explorer is served at /graphql");

const initial = await graphql<{
  readonly viewer: { readonly name: string; readonly online: boolean };
  readonly users: readonly { readonly id: string; readonly name: string }[];
  readonly post: {
    readonly title: string;
    readonly comments: readonly { readonly id: string; readonly body: string }[];
  };
}>({
  query: /* GraphQL */ `
    query SmokeInitial($postId: ID!) {
      viewer {
        name
        online
      }
      users {
        id
        name
      }
      post(id: $postId) {
        title
        comments {
          id
          body
        }
      }
    }
  `,
  variables: { postId: "p1" },
});

assertEqual(initial.viewer.name, "Ada Lovelace", "viewer comes from Yoga context services");
assertEqual(initial.users.length, 3, "users query returns fixture data");
assertEqual(initial.post.comments.length, 2, "post comments relation is resolved");

const mutation = api.comment.add;
const added = await graphql<{
  readonly addComment: { readonly id: string; readonly body: string };
}>({
  query: mutation.query,
  variables: mutation.variables({
    postId: "p1",
    body: "Smoke test created this comment.",
  }),
  operationName: mutation.operationName,
});

assertEqual(added.addComment.body, "Smoke test created this comment.", "generated mutation works");

const afterMutation = await graphql<{
  readonly post: { readonly comments: readonly { readonly id: string }[] };
}>({
  query: /* GraphQL */ `
    query SmokeAfterMutation($postId: ID!) {
      post(id: $postId) {
        comments {
          id
        }
      }
    }
  `,
  variables: { postId: "p1" },
});

assertEqual(afterMutation.post.comments.length, 3, "mutation updates server state");

console.log("example smoke test passed");

async function graphql<T>(input: {
  readonly query: string;
  readonly variables?: Record<string, unknown> | undefined;
  readonly operationName?: string | undefined;
}): Promise<T> {
  const response = await yoga.fetch("http://example.test/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = (await response.json()) as GraphQLPayload<T>;

  if (!response.ok || payload.errors?.length || !payload.data) {
    throw new Error(payload.errors?.[0]?.message ?? `GraphQL request failed: ${response.status}`);
  }

  return payload.data;
}

async function graphqlViaApp<T>(input: {
  readonly query: string;
  readonly variables?: Record<string, unknown> | undefined;
  readonly operationName?: string | undefined;
}): Promise<T> {
  const response = await app.handle(
    new Request("http://example.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  const payload = (await response.json()) as GraphQLPayload<T>;

  if (!response.ok || payload.errors?.length || !payload.data) {
    throw new Error(payload.errors?.[0]?.message ?? `GraphQL request failed: ${response.status}`);
  }

  return payload.data;
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

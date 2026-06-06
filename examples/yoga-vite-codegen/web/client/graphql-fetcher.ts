import type { Fetcher } from "@gqlens/core";

export const graphqlFetcher: Fetcher = async (operation) => {
  const response = await fetch("/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: operation.query,
      variables: operation.variables,
      operationName: operation.operationName,
    }),
  });

  const payload = (await response.json()) as {
    readonly data?: unknown;
    readonly errors?: readonly { readonly message?: string }[] | undefined;
  };

  if (!response.ok || payload.errors?.length) {
    throw new Error(payload.errors?.[0]?.message ?? `GraphQL request failed: ${response.status}`);
  }

  return payload.data ?? {};
};

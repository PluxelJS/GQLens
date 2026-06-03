export type BuiltInFramework = "react" | "solid";

export interface AccessorAdapter {
  readonly module: string;
  readonly querySessionImport: string;
  readonly liveSessionImport: string;
  readonly querySessionHook: string;
  readonly liveSessionHook: string;
  readonly queryExport: string;
  readonly liveQueryExport: string;
}

const builtInAdapters: Record<BuiltInFramework, AccessorAdapter> = {
  react: {
    module: "@gqlens/react",
    querySessionImport: "useGQLensSession",
    liveSessionImport: "useLiveGQLensSession",
    querySessionHook: "useGQLensSession",
    liveSessionHook: "useLiveGQLensSession",
    queryExport: "useQuery",
    liveQueryExport: "useLiveQuery",
  },
  solid: {
    module: "@gqlens/solid",
    querySessionImport: "createQuery as createGQLensSession",
    liveSessionImport: "createLiveQuery as createLiveGQLensSession",
    querySessionHook: "createGQLensSession",
    liveSessionHook: "createLiveGQLensSession",
    queryExport: "createQuery",
    liveQueryExport: "createLiveQuery",
  },
};

export function resolveAdapter(
  framework: BuiltInFramework | undefined,
  adapter: AccessorAdapter | undefined,
): AccessorAdapter {
  return adapter ?? builtInAdapters[framework ?? "react"];
}

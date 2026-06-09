export type BuiltInFramework = "react" | "solid";

export interface AccessorAdapter {
  readonly module: string;
  readonly querySessionImport: string;
  readonly liveSessionImport: string;
  readonly queryConfigImport?: string | undefined;
  readonly queryConfigType?: string | undefined;
  readonly querySessionHook: string;
  readonly liveSessionHook: string;
  readonly queryExport: string;
  readonly liveQueryExport: string;
  readonly preparedQueryExport?: string | undefined;
}

const builtInAdapters: Record<BuiltInFramework, AccessorAdapter> = {
  react: {
    module: "@gqlens/react",
    querySessionImport: "useGQLensSession",
    liveSessionImport: "useLiveGQLensSession",
    queryConfigImport: "type QueryConfig as GQLensQueryConfig",
    queryConfigType: "GQLensQueryConfig",
    querySessionHook: "useGQLensSession",
    liveSessionHook: "useLiveGQLensSession",
    queryExport: "useQuery",
    liveQueryExport: "useLiveQuery",
    preparedQueryExport: "usePreparedQuery",
  },
  solid: {
    module: "@gqlens/solid",
    querySessionImport: "createQuery as createGQLensSession",
    liveSessionImport: "createLiveQuery as createLiveGQLensSession",
    queryConfigImport: "type QueryConfig as GQLensQueryConfig",
    queryConfigType: "GQLensQueryConfig",
    querySessionHook: "createGQLensSession",
    liveSessionHook: "createLiveGQLensSession",
    queryExport: "createQuery",
    liveQueryExport: "createLiveQuery",
    preparedQueryExport: "createPreparedQuery",
  },
};

export function resolveAdapter(
  framework: BuiltInFramework | undefined,
  adapter: AccessorAdapter | undefined,
): AccessorAdapter {
  return adapter ?? builtInAdapters[framework ?? "react"];
}

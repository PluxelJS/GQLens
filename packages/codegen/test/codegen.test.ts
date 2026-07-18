import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildSchema } from "graphql";
import { generateFiles, type GQLensCodegenError } from "@gqlens/codegen";

const fixturesRoot = new URL("./fixtures/", import.meta.url);
const basicFixture = fixtureUrl("basic");
const generatedFixtureFiles = ["types.ts", "invalidation.ts", "accessor.ts"] as const;
const testSchema = readFixture("schema.graphql");
const fixtureNames = readdirSync(fixturesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted();

function readFixture(fileName: string): string {
  return readFileSync(new URL(fileName, basicFixture), "utf8");
}

function fixtureUrl(name: string): URL {
  return new URL(`${name}/`, fixturesRoot);
}

function readFixtureFile(fixtureName: string, fileName: string): string {
  return readFileSync(new URL(fileName, fixtureUrl(fixtureName)), "utf8");
}

describe("@gqlens/codegen", () => {
  test.each(fixtureNames)("matches checked-in %s fixture files", async (fixtureName) => {
    const files = await generateFiles({ schema: readFixtureFile(fixtureName, "schema.graphql") });

    for (const fileName of generatedFixtureFiles) {
      expect(files[fileName]).toBe(readFixtureFile(fixtureName, fileName));
    }
  });

  test("accepts a GraphQLSchema object", async () => {
    const files = await generateFiles({
      schema: buildSchema(testSchema),
    });

    expect(files).toMatchObject({
      "types.ts": readFixture("types.ts"),
      "invalidation.ts": readFixture("invalidation.ts"),
      "accessor.ts": readFixture("accessor.ts"),
    });
  });

  test("ends generated accessors with exactly one newline", async () => {
    const files = await generateFiles({
      schema: "type Query { greeting: String! }",
    });

    expect(files["accessor.ts"]).toMatch(/[^\n]\n$/);
  });

  test("wraps invalid SDL as a stable codegen error", async () => {
    await expect(generateFiles({ schema: "type Query {" })).rejects.toMatchObject({
      name: "GQLensCodegenError",
      code: "INVALID_SCHEMA_INPUT",
    } satisfies Partial<GQLensCodegenError>);
  });

  test("uses GraphQL Code Generator-compatible args type names", async () => {
    const files = await generateFiles({ schema: testSchema });
    const types = files["types.ts"]!;
    const accessor = files["accessor.ts"]!;

    expect(types).toContain("QueryUserArgs");
    expect(types).toContain("MutationRenameUserArgs");
    expect(accessor).toContain("user: (args: GQLensArgs<Types.QueryUserArgs>)");
  });

  test("mutation descriptors carry schema contract and selected result types", async () => {
    const files = await generateFiles({ schema: testSchema });
    const accessor = files["accessor.ts"]!;

    expect(accessor).toContain("schema: gqlensSchema");
    expect(accessor).toContain(
      'MutationOperation<Types.MutationRenameUserArgs, Pick<NonNullable<Types.Mutation["renameUser"]>, "id" | "__typename" | "name" | "avatar" | "online">>',
    );
  });

  test("mutation descriptors support list object results", async () => {
    const files = await generateFiles({
      schema: /* graphql */ `
        type Group {
          id: ID!
          name: String!
        }

        input GroupInput {
          name: String!
        }

        type Query {
          groups: [Group!]!
        }

        type Mutation {
          updateGroups(groups: [GroupInput!]!): [Group!]!
        }
      `,
    });

    expect(files["accessor.ts"]).toContain(
      'MutationOperation<Types.MutationUpdateGroupsArgs, Array<Pick<NonNullable<NonNullable<Types.Mutation["updateGroups"]>[number]>, "id" | "__typename" | "name">>>',
    );
  });

  test("uses the same args type names as GraphQL Code Generator", async () => {
    const files = await generateFiles({
      schema: /* graphql */ `
        type User {
          id: ID!
        }

        type Query {
          user_by_id(user_id: ID!): User
          useURL(URL: String!): User
        }
      `,
    });

    const types = files["types.ts"]!;
    const accessor = files["accessor.ts"]!;
    expect(types).toContain("export type QueryUser_By_IdArgs");
    expect(types).toContain("export type QueryUseUrlArgs");
    expect(accessor).toContain("user_by_id: (args: GQLensArgs<Types.QueryUser_By_IdArgs>)");
    expect(accessor).toContain("useURL: (args: GQLensArgs<Types.QueryUseUrlArgs>)");
  });

  test("supports solid framework option", async () => {
    const files = await generateFiles({ schema: testSchema, framework: "solid" });
    const accessor = files["accessor.ts"]!;
    expect(accessor).toContain(
      'import { createQuery as createGQLensSession, createLiveQuery as createLiveGQLensSession, type QueryConfig as GQLensQueryConfig } from "@gqlens/solid"',
    );
    expect(accessor).toContain("export function createQuery");
    expect(accessor).toContain("export function createLiveQuery");
    expect(accessor).toContain("export function createPreparedQuery");
  });

  test("supports custom adapter descriptors", async () => {
    const files = await generateFiles({
      schema: testSchema,
      adapter: {
        module: "@gqlens/vue",
        querySessionImport: "useGQLensVueSession",
        liveSessionImport: "useLiveGQLensVueSession",
        querySessionHook: "useGQLensVueSession",
        liveSessionHook: "useLiveGQLensVueSession",
        queryExport: "useQuery",
        liveQueryExport: "useLiveQuery",
      },
    });

    const accessor = files["accessor.ts"]!;
    expect(accessor).toContain(
      'import { useGQLensVueSession, useLiveGQLensVueSession } from "@gqlens/vue"',
    );
    expect(accessor).toContain("const state = useGQLensVueSession");
    expect(accessor).toContain("const state = useLiveGQLensVueSession");
  });

  test("rejects object lists whose item type has no id", async () => {
    await expect(
      generateFiles({
        schema: /* graphql */ `
          type Summary {
            total: Int!
          }

          type Query {
            summaries: [Summary!]!
          }
        `,
      }),
    ).rejects.toThrow("Query.summaries returns a list of Value Object Summary");
  });

  test("rejects nullable id fields", async () => {
    await expect(
      generateFiles({
        schema: /* graphql */ `
          type User {
            id: ID
            name: String!
          }

          type Query {
            user(id: ID!): User
          }
        `,
      }),
    ).rejects.toThrow("User.id must be a non-null scalar field");
  });

  test("rejects abstract fields with value object possible types", async () => {
    await expect(
      generateFiles({
        schema: /* graphql */ `
          union SearchResult = User | Summary

          type User {
            id: ID!
            name: String!
          }

          type Summary {
            total: Int!
          }

          type Query {
            search: [SearchResult!]!
          }
        `,
      }),
    ).rejects.toThrow(
      "Query.search returns abstract SearchResult with Value Object possible types",
    );
  });
});

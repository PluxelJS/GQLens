import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildSchema } from "graphql";
import { generateFiles } from "@gqlens/codegen";

const fixturesRoot = new URL("./fixtures/", import.meta.url);
const basicFixture = fixtureUrl("basic");
const generatedFixtureFiles = [
  "types.ts",
  "normalizer.ts",
  "invalidation.ts",
  "accessor.ts",
] as const;
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
      "normalizer.ts": readFixture("normalizer.ts"),
      "invalidation.ts": readFixture("invalidation.ts"),
      "accessor.ts": readFixture("accessor.ts"),
    });
  });

  test("uses GraphQL Code Generator-compatible args type names", async () => {
    const files = await generateFiles({ schema: testSchema });
    const types = files["types.ts"]!;
    const accessor = files["accessor.ts"]!;

    expect(types).toContain("QueryUserArgs");
    expect(types).toContain("MutationRenameUserArgs");
    expect(accessor).toContain("user: (args: GQLensArgs<Types.QueryUserArgs>)");
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
      'import { createQuery as createGQLensSession, createLiveQuery as createLiveGQLensSession } from "@gqlens/solid"',
    );
    expect(accessor).toContain("export function createQuery");
    expect(accessor).toContain("export function createLiveQuery");
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
});

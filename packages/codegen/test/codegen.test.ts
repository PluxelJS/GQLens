import { describe, expect, test } from "vitest";
import { createFixture, type FsFixture } from "fs-fixture";
import { buildSchema } from "graphql";
import { generateFiles } from "@gqlens/codegen";

const testSchema = /* graphql */ `
  interface Node {
    id: ID!
  }

  type User implements Node {
    id: ID!
    name: String!
    avatar: String
    online: Boolean!
    posts: [Post!]!
  }

  type Post implements Node {
    id: ID!
    title: String!
    content: String!
    tags: [String!]!
    author: User!
    comments: [Comment!]!
  }

  type Comment {
    id: ID!
    body: String!
    author: User!
  }

  interface Pet {
    id: ID!
    name: String!
  }

  type Cat implements Pet {
    id: ID!
    name: String!
    meows: Boolean!
  }

  type Dog implements Pet {
    id: ID!
    name: String!
    barks: Boolean!
  }

  union SearchResult = User | Post

  type Query {
    user(id: ID!): User
    viewer: User
    post(id: ID!): Post
    posts(first: Int, done: Boolean): [Post!]!
    pet(id: ID!): Pet
    search(text: String!): [SearchResult!]!
  }

  type Mutation {
    renameUser(id: ID!, name: String!): User!
    addComment(postId: ID!, content: String!): Comment!
  }

  enum Status {
    ACTIVE
    INACTIVE
  }
`;

describe("@gqlens/codegen", () => {
  test("generates type definitions from schema", async () => {
    const files = await generateFiles({ schema: testSchema });
    const types = files["types.ts"]!;
    // Codegen emits type aliases, Scalars map, and Maybe helpers.
    expect(types).toContain("export type User =");
    expect(types).toContain("id: Scalars['ID']['output']");
    expect(types).toContain("name: Scalars['String']['output']");
    expect(types).toContain("avatar?: Maybe<Scalars['String']['output']>");
    expect(types).toContain("online: Scalars['Boolean']['output']");
    expect(types).toContain("posts: Array<Post>");
    expect(types).toContain("export type Post =");
    // Status enum is generated as a union type.
    expect(types).toContain("export type Status =");
    expect(types).toContain("'ACTIVE'");
    // Args types generated
    expect(types).toContain("QueryUserArgs");
    expect(types).toContain("MutationRenameUserArgs");
  });

  test("generates normalizer metadata", async () => {
    const files = await generateFiles({ schema: testSchema });
    const normalizer = files["normalizer.ts"]!;
    expect(normalizer).toContain('type: "User"');
    expect(normalizer).toContain('nestedType: "Post"');
    expect(normalizer).toContain("isList: true");
    expect(normalizer).toContain('import type { NormalizerEntry } from "@gqlens/core/codegen"');
  });

  test("generates invalidation spec union", async () => {
    const files = await generateFiles({ schema: testSchema });
    const invalidation = files["invalidation.ts"]!;
    expect(invalidation).toContain("export type InvalidationSpec");
    expect(invalidation).toContain('import type { InvalidationTarget } from "@gqlens/core"');
    expect(invalidation).toContain("EntityInvalidationSpec | InvalidationTarget");
    expect(invalidation).toContain('"name"');
    expect(invalidation).toContain('"avatar"');
    expect(invalidation).toContain('"title"');
    expect(invalidation).toContain('"body"');
  });

  test("generates accessor file with adapter import", async () => {
    const files = await generateFiles({ schema: testSchema });
    const accessor = files["accessor.ts"]!;
    expect(accessor).toContain(
      'import { useGQLensSession, useLiveGQLensSession } from "@gqlens/react"',
    );
    expect(accessor).toContain('import type * as Types from "./types"');
    expect(accessor).toContain("createAccessorNode,");
    expect(accessor).toContain("defineInvalidation as defineGQLensInvalidation");
    expect(accessor).toContain("defineSelection as defineGQLensSelection");
    expect(accessor).toContain(
      'import type { EntityRef, MutationOperation, QuerySessionConfig } from "@gqlens/core"',
    );
    expect(accessor).toContain("metadata: schemaMeta.planner");
    expect(accessor).toContain("planner:");
    expect(accessor).toContain('"id": "ID!"');
    expect(accessor).toContain('demand: (steps) => state.demand("Query", steps)');
    expect(accessor).toContain("read: state.read");
    expect(accessor).toContain("export function useQuery");
    expect(accessor).toContain('readonly tags: Types.Post["tags"]');
    expect(accessor).toContain("args?: Types.QueryPostsArgs");
    expect(accessor).toContain("export function useLiveQuery");
    expect(accessor).toContain("export const api = {");
    expect(accessor).toContain("user: {");
    expect(accessor).toContain("rename:");
    expect(accessor).toContain("variables: (input: Types.MutationRenameUserArgs)");
    expect(accessor).toContain("comment: {");
    expect(accessor).toContain("add:");
    expect(accessor).toContain("variables: (input: Types.MutationAddCommentArgs)");
    expect(accessor).toContain("satisfies MutationOperation");
    expect(accessor).toContain("mutation renameUser($id: ID!, $name: String!)");
    expect(accessor).not.toContain("Promise.resolve");
    expect(accessor).toContain("comment: {");
    expect(accessor).toContain("add:");
    expect(accessor).toContain("export function defineSelection");
    expect(accessor).toContain("export function defineInvalidation");
  });

  test("generates abstract accessors and planner metadata", async () => {
    const files = await generateFiles({ schema: testSchema });
    const accessor = files["accessor.ts"]!;

    expect(accessor).toContain("export interface NodeNode");
    expect(accessor).toContain("export interface PetNode");
    expect(accessor).toContain("readonly __typename: string | undefined");
    expect(accessor).toContain("readonly $on: {");
    expect(accessor).toContain("readonly Cat: CatNode");
    expect(accessor).toContain("readonly Dog: DogNode");
    expect(accessor).toContain("readonly Node: NodeNode");
    expect(accessor).toContain(
      "search: (args: Types.QuerySearchArgs) => { readonly refs: readonly EntityRef[] | undefined }",
    );
    expect(accessor).toContain('isAbstract: true, possibleTypes: ["Cat","Dog"]');
    expect(accessor).toContain('isAbstract: true, possibleTypes: ["User","Post"]');
    expect(accessor).toContain('typeConditions: ["User","Post","Node"]');
    expect(accessor).toContain(
      '"__typename": { returnsEntity: false, possibleTypes: ["Cat","Dog"] }',
    );
    expect(accessor).toContain('"__typename": { name: "__typename", kind: "scalar" }');
    expect(accessor).toContain(
      '"search": { returnsEntity: true, graphQLType: "SearchResult", isAbstract: true, possibleTypes: ["User","Post"], returnsList: true, args: { "text": "String!" } }',
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
    expect(accessor).toContain("user_by_id: (args: Types.QueryUser_By_IdArgs)");
    expect(accessor).toContain("useURL: (args: Types.QueryUseUrlArgs)");
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

  test("accepts a GraphQLSchema object", async () => {
    const files = await generateFiles({
      schema: buildSchema(testSchema),
    });

    expect(files["types.ts"]).toContain("export type User =");
    expect(files["accessor.ts"]).toContain("export function useQuery");
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

  test("writes output to fs-fixture directory", async () => {
    let f: FsFixture | undefined;
    try {
      f = await createFixture();
      const files = await generateFiles({ schema: testSchema });

      await f.writeFile("types.ts", files["types.ts"]!, "utf8");
      await f.writeFile("normalizer.ts", files["normalizer.ts"]!, "utf8");
      await f.writeFile("invalidation.ts", files["invalidation.ts"]!, "utf8");
      await f.writeFile("accessor.ts", files["accessor.ts"]!, "utf8");

      expect(await f.exists("types.ts")).toBe(true);
      expect(await f.exists("normalizer.ts")).toBe(true);
      expect(await f.exists("invalidation.ts")).toBe(true);
      expect(await f.exists("accessor.ts")).toBe(true);
    } finally {
      await f?.rm();
    }
  });
});

import { describe, expect, test } from "vitest";
import { createFixture, type FsFixture } from "fs-fixture";
import { generate } from "@gqlens/codegen";

const testSchema = /* graphql */ `
  type User {
    id: ID!
    name: String!
    avatar: String
    online: Boolean!
    posts: [Post!]!
  }

  type Post {
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

  type Query {
    user(id: ID!): User
    viewer: User
    post(id: ID!): Post
    posts(first: Int, done: Boolean): [Post!]!
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
    const result = await generate({ schema: testSchema, output: "/gqlens" });
    const types = result.files["types.ts"]!;
    // Plugin generates type aliases, Scalars map, Maybe helpers
    expect(types).toContain("export type User = {");
    expect(types).toContain("id: Scalars['ID']['output']");
    expect(types).toContain("name: Scalars['String']['output']");
    expect(types).toContain("avatar?: Maybe<Scalars['String']['output']>");
    expect(types).toContain("online: Scalars['Boolean']['output']");
    expect(types).toContain("posts: Array<Post>");
    expect(types).toContain("export type Post = {");
    // Status enum is generated as union type
    expect(types).toContain("export type Status =");
    expect(types).toContain("'ACTIVE'");
    // Args types generated
    expect(types).toContain("QueryUserArgs");
    expect(types).toContain("MutationRenameUserArgs");
  });

  test("generates normalizer metadata", async () => {
    const result = await generate({ schema: testSchema, output: "/gqlens" });
    const normalizer = result.files["normalizer.ts"]!;
    expect(normalizer).toContain('type: "User"');
    expect(normalizer).toContain('nestedType: "Post"');
    expect(normalizer).toContain("isList: true");
    expect(normalizer).toContain('import type { NormalizerEntry } from "@gqlens/core/codegen"');
  });

  test("generates invalidation spec union", async () => {
    const result = await generate({ schema: testSchema, output: "/gqlens" });
    const invalidation = result.files["invalidation.ts"]!;
    expect(invalidation).toContain("export type InvalidationSpec");
    expect(invalidation).toContain('"name"');
    expect(invalidation).toContain('"avatar"');
    expect(invalidation).toContain('"title"');
    expect(invalidation).toContain('"body"');
  });

  test("generates accessor file with adapter import", async () => {
    const result = await generate({ schema: testSchema, output: "/gqlens" });
    const accessor = result.files["accessor.ts"]!;
    expect(accessor).toContain(
      'import { useGQLensSession, useLiveGQLensSession } from "@gqlens/react"',
    );
    expect(accessor).toContain('import type * as Types from "./types"');
    expect(accessor).toContain('import { createAccessorNode } from "@gqlens/core/codegen"');
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
  });

  test("uses the same args type names as GraphQL Code Generator", async () => {
    const result = await generate({
      schema: /* graphql */ `
        type User {
          id: ID!
        }

        type Query {
          user_by_id(user_id: ID!): User
          useURL(URL: String!): User
        }
      `,
      output: "/gqlens",
    });

    const types = result.files["types.ts"]!;
    const accessor = result.files["accessor.ts"]!;
    expect(types).toContain("export type QueryUser_By_IdArgs");
    expect(types).toContain("export type QueryUseUrlArgs");
    expect(accessor).toContain("user_by_id: (args: Types.QueryUser_By_IdArgs)");
    expect(accessor).toContain("useURL: (args: Types.QueryUseUrlArgs)");
  });

  test("supports solid framework option", async () => {
    const result = await generate({ schema: testSchema, output: "/gqlens", framework: "solid" });
    const accessor = result.files["accessor.ts"]!;
    expect(accessor).toContain(
      'import { createQuery as createGQLensSession, createLiveQuery as createLiveGQLensSession } from "@gqlens/solid"',
    );
    expect(accessor).toContain("export function createQuery");
    expect(accessor).toContain("export function createLiveQuery");
  });

  test("supports custom adapter descriptors", async () => {
    const result = await generate({
      schema: testSchema,
      output: "/gqlens",
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

    const accessor = result.files["accessor.ts"]!;
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
      const result = await generate({ schema: testSchema, output: "/gqlens" });

      await f.writeFile("types.ts", result.files["types.ts"]!, "utf8");
      await f.writeFile("normalizer.ts", result.files["normalizer.ts"]!, "utf8");
      await f.writeFile("invalidation.ts", result.files["invalidation.ts"]!, "utf8");
      await f.writeFile("accessor.ts", result.files["accessor.ts"]!, "utf8");

      expect(await f.exists("types.ts")).toBe(true);
      expect(await f.exists("normalizer.ts")).toBe(true);
      expect(await f.exists("invalidation.ts")).toBe(true);
      expect(await f.exists("accessor.ts")).toBe(true);
    } finally {
      await f?.rm();
    }
  });
});

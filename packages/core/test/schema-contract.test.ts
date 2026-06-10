import { describe, expect, test } from "vitest";
import type { GQLensSchemaContract } from "@gqlens/core";

describe("core/codegen schema contracts", () => {
  test("schema contract stays JSON-serializable", () => {
    const schema: GQLensSchemaContract = {
      query: {
        type: "Query",
        kind: "root",
        fields: {
          __typename: { name: "__typename", result: { kind: "scalar", cardinality: "one" } },
          viewer: {
            name: "viewer",
            result: {
              kind: "object",
              cardinality: "one",
              typeName: "User",
              objectKind: "entity",
            },
          },
          search: {
            name: "search",
            result: {
              kind: "object",
              cardinality: "list",
              typeName: "SearchResult",
              objectKind: "entity",
              isAbstract: true,
              possibleTypes: ["User", "Post"],
            },
            args: { text: "String!" },
          },
        },
      },
      objects: {
        User: {
          type: "User",
          kind: "entity",
          fields: {
            __typename: { name: "__typename", result: { kind: "scalar", cardinality: "one" } },
            id: { name: "id", result: { kind: "scalar", cardinality: "one" } },
            tags: { name: "tags", result: { kind: "scalar", cardinality: "list" } },
            profile: {
              name: "profile",
              result: {
                kind: "object",
                cardinality: "one",
                typeName: "Profile",
                objectKind: "value",
              },
            },
          },
        },
        Profile: {
          type: "Profile",
          kind: "value",
          fields: {
            __typename: { name: "__typename", result: { kind: "scalar", cardinality: "one" } },
            bio: { name: "bio", result: { kind: "scalar", cardinality: "one" } },
          },
        },
        SearchResult: {
          type: "SearchResult",
          kind: "entity",
          fields: {
            __typename: { name: "__typename", result: { kind: "scalar", cardinality: "one" } },
          },
          isAbstract: true,
          possibleTypes: ["User", "Post"],
          typeConditions: ["User", "Post"],
        },
      },
    };

    expect(JSON.parse(JSON.stringify(schema))).toStrictEqual(schema);
  });
});

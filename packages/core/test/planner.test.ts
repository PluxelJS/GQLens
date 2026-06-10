import { describe, expect, test } from "vitest";
import { plan, type SelectionPath, type SelectionStep } from "@gqlens/core";
import { schemaContract } from "./cache-helpers";

const p = (steps: SelectionStep[]): SelectionPath => ({
  root: "Query",
  steps,
});

// ─── Planner ───────────────────────────────────────────────────────────────

describe("Planner", () => {
  test("generates operation with entity ref fields", () => {
    const op = plan([p([{ field: "user", args: { id: "1" } }, { field: "name" }])]);

    expect(op.operationName).toBe("GQLens");
    expect(op.query).toContain("__typename");
    expect(op.query).toContain("id");
    expect(op.query).toContain("name");
  });

  test("merges fields under same root+args", () => {
    const op = plan([
      p([{ field: "user", args: { id: "1" } }, { field: "name" }]),
      p([{ field: "user", args: { id: "1" } }, { field: "avatar" }]),
    ]);

    // Single user field, with both name and avatar inside
    const userCount = op.query.split("user").length - 1;
    expect(userCount).toBe(1);
    expect(op.query).toContain("name");
    expect(op.query).toContain("avatar");
  });

  test("generates aliases for same field with different args", () => {
    const op = plan([
      p([{ field: "user", args: { id: "1" } }, { field: "name" }]),
      p([{ field: "user", args: { id: "2" } }, { field: "name" }]),
    ]);

    expect(op.query).toContain("user_0: user");
    expect(op.query).toContain("user_1: user");
  });

  test("handles nested fields via recursive tree building", () => {
    const op = plan([
      p([
        { field: "user", args: { id: "1" } },
        { field: "posts", args: { first: 10 } },
        { field: "title" },
      ]),
      p([{ field: "user", args: { id: "1" } }, { field: "name" }]),
    ]);

    // name is a top-level field of user
    // title is nested inside posts(first:10)
    expect(op.query).toContain("posts(first:");
    expect(op.query).toContain("title");
    expect(op.query).toContain("name");
    expect(op.variables).toHaveProperty("v1");
    expect(op.variables["v1"]).toBe(10);
  });

  test("deduplicates variables by value and separates distinct values", () => {
    const op = plan([
      p([{ field: "user", args: { id: "1" } }, { field: "name" }]),
      p([{ field: "user", args: { id: "1" } }, { field: "avatar" }]),
      p([{ field: "user", args: { id: "2" } }, { field: "avatar" }]),
    ]);

    expect(op.variables).toStrictEqual({ v0: "1", v1: "2" });
  });

  test("returns correct GraphQL types for variables", () => {
    const op = plan([p([{ field: "todos", args: { first: 10, done: false } }, { field: "ids" }])]);

    const query = op.query;
    expect(query).toContain(": Int");
    expect(query).toContain(": Boolean");
  });

  test("uses schema contract for variable types", () => {
    const op = plan(
      [p([{ field: "user", args: { id: "1" } }, { field: "name" }])],
      "query",
      schemaContract({
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      }),
    );

    expect(op.query).toContain("$v0: ID!");
  });

  test("deduplicates variables within GraphQL type boundaries", () => {
    const op = plan(
      [
        p([{ field: "node", args: { id: "1" } }, { field: "name" }]),
        p([{ field: "search", args: { text: "1" } }, { field: "title" }]),
        p([{ field: "search", args: { text: "1" } }, { field: "summary" }]),
      ],
      "query",
      schemaContract({
        roots: {
          node: { returnsEntity: true, graphQLType: "Node", args: { id: "ID!" } },
          search: { returnsEntity: true, graphQLType: "SearchResult", args: { text: "String!" } },
        },
      }),
    );

    expect(Object.keys(op.variables)).toHaveLength(2);
    expect(op.variables).toStrictEqual({ v0: "1", v1: "1" });
    expect(op.query).toContain("$v0: ID!");
    expect(op.query).toContain("$v1: String!");
  });

  test("treats list ids as an accessor pseudo-field", () => {
    const op = plan(
      [p([{ field: "todos", args: { done: false } }, { field: "ids" }])],
      "query",
      schemaContract({
        roots: {
          todos: {
            returnsEntity: true,
            cardinality: "list",
            graphQLType: "Todo",
            args: { done: "Boolean" },
          },
        },
      }),
    );

    expect(op.query).toContain("todos(done:");
    expect(op.query).toContain("__typename");
    expect(op.query).not.toContain("ids");
  });

  test("treats abstract list refs as an accessor pseudo-field", () => {
    const op = plan(
      [p([{ field: "search", args: { text: "milk" } }, { field: "refs" }])],
      "query",
      schemaContract({
        roots: {
          search: {
            returnsEntity: true,
            cardinality: "list",
            graphQLType: "SearchResult",
            isAbstract: true,
            possibleTypes: ["User", "Post"],
            args: { text: "String!" },
          },
        },
      }),
    );

    expect(op.query).toContain("search(text:");
    expect(op.query).toContain("__typename");
    expect(op.query).toContain("... on Post");
    expect(op.query).toContain("... on User");
    expect(op.query).not.toContain("refs");
  });

  test("renders inline fragments from $on steps", () => {
    const op = plan(
      [
        p([
          { field: "pet", args: { id: "1" } },
          { field: "$on", typeCondition: "Cat" },
          { field: "meows" },
        ]),
      ],
      "query",
      schemaContract({
        roots: { pet: { returnsEntity: true, graphQLType: "Pet", args: { id: "ID!" } } },
        types: {
          Pet: { __typename: { returnsEntity: false, possibleTypes: ["Cat", "Dog"] } },
          Cat: { meows: { returnsEntity: false } },
        },
      }),
    );

    expect(op.query).toContain("pet(id:");
    expect(op.query).toContain("... on Cat");
    expect(op.query).toContain("meows");
    expect(op.query).not.toContain("$on");
    expect(op.selections[0]?.steps[1]?.responseKey).toBeUndefined();
    expect(op.selections[0]?.steps[2]?.responseKey).toBe("meows");
  });

  test("uses named variable placeholders without concrete values", () => {
    const op = plan(
      [p([{ field: "user", args: { id: { __gqlensVariable: "id" } } }, { field: "name" }])],
      "query",
      schemaContract({
        roots: { user: { returnsEntity: true, graphQLType: "User", args: { id: "ID!" } } },
        types: { User: { name: { returnsEntity: false } } },
      }),
    );

    expect(op.query).toContain("user(id: $id)");
    expect(op.query).toContain("$id: ID!");
    expect(op.variables).toStrictEqual({});
  });

  test("records response aliases for planned selections", () => {
    const op = plan([
      p([{ field: "user", args: { id: "1" } }, { field: "name" }]),
      p([{ field: "user", args: { id: "2" } }, { field: "name" }]),
    ]);

    expect(op.selections[0]?.steps[0]?.responseKey).toBe("user_0");
    expect(op.selections[1]?.steps[0]?.responseKey).toBe("user_1");
  });

  test("empty paths produce minimal query", () => {
    const op = plan([]);
    expect(op.query).toContain("__typename");
  });

  test("supports mutation operation type", () => {
    const op = plan(
      [
        {
          root: "Mutation",
          steps: [{ field: "renameUser", args: { id: "1", name: "Bob" } }, { field: "id" }],
        },
      ],
      "mutation",
    );
    expect(op.query).toContain("mutation");
    expect(op.query).toContain("renameUser");
  });

  test("no-arg root fields are handled cleanly", () => {
    const op = plan([p([{ field: "viewer" }, { field: "name" }])]);
    expect(op.query).toContain("viewer {");
  });

  test("renders deeply nested inline fragments from $on chains", () => {
    const schema = schemaContract({
      roots: {
        node: { returnsEntity: true, graphQLType: "Node", args: { id: "ID!" } },
      },
      types: {
        Node: { __typename: { returnsEntity: false, possibleTypes: ["A", "B", "C"] } },
        A: {
          id: { returnsEntity: false },
          b: { returnsEntity: true, graphQLType: "Node" },
        },
        B: {
          id: { returnsEntity: false },
          c: { returnsEntity: true, graphQLType: "Node" },
        },
        C: { name: { returnsEntity: false } },
      },
    });

    const op = plan(
      [
        p([
          { field: "node", args: { id: "1" } },
          { field: "$on", typeCondition: "A" },
          { field: "b" },
          { field: "$on", typeCondition: "B" },
          { field: "c" },
          { field: "$on", typeCondition: "C" },
          { field: "name" },
        ]),
      ],
      "query",
      schema,
    );

    expect(op.query).toContain("node(id:");
    expect(op.query).toContain("... on A");
    expect(op.query).toContain("... on B");
    expect(op.query).toContain("... on C");
    expect(op.query).toContain("name");
    expect(op.query).not.toContain("$on");
    expect(op.selections[0]?.steps[0]?.field).toBe("node");
    expect(op.selections[0]?.steps[1]?.typeCondition).toBe("A");
  });
});

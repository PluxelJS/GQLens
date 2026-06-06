import { commentsInvalidation, userCardSelection } from "../web/client/generated-usage";
import { api } from "../web/gqlens/accessor";

assertEqual(api.comment.add.operationName, "addComment", "comment mutation name");
assertEqual(
  api.comment.add.query,
  "mutation addComment($postId: ID!, $body: String!) { addComment(postId: $postId, body: $body) { id __typename body } }",
  "comment mutation query",
);
assertDeepEqual(
  api.comment.add.variables({ postId: "p1", body: "hello" }),
  { postId: "p1", body: "hello" },
  "comment mutation variables",
);

assertEqual(api.userOnline.toggle.operationName, "toggleUserOnline", "toggle mutation name");
assertDeepEqual(api.userOnline.toggle.variables({ id: "u1" }), { id: "u1" }, "toggle variables");

assertEqual(userCardSelection.variables.includes("userId"), true, "selection tracks variables");
assertEqual(userCardSelection.paths.length, 2, "selection tracks accessed fields");
assertEqual(commentsInvalidation.kind, "selection", "invalidation tracks accessor selection");

console.log("frontend contract test passed");

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

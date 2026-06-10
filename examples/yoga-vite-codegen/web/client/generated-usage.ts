import type { PreparedSelection } from "@gqlens/core";
import { api, defineInvalidation, defineSelection, type QueryNode } from "../gqlens/accessor";
import type { Invalidation } from "../gqlens/invalidation";
import type * as Types from "../gqlens/types";
import { createIndexedDBGraphDataRecords } from "./idb-records";

export function readGeneratedAccessor(q: QueryNode): {
  readonly viewerName: Types.User["name"] | undefined;
  readonly userIds: readonly string[] | undefined;
  readonly postCommentIds: readonly string[] | undefined;
  readonly firstPostTitle: Types.Post["title"] | undefined;
} {
  const postIds = q.posts.ids ?? [];
  const firstPostId = postIds[0] ?? "p1";
  return {
    viewerName: q.viewer.name,
    userIds: q.users.ids,
    postCommentIds: q.post({ id: firstPostId }).comments.ids,
    firstPostTitle: q.post({ id: firstPostId }).title,
  };
}

export const userCardSelection: PreparedSelection = defineSelection((q, v) => {
  void q.user({ id: v("userId") }).name;
  void q.user({ id: v("userId") }).posts.ids;
});

export const commentsInvalidation = defineInvalidation((q) => q.post({ id: "p1" }).comments.ids);

export const typedInvalidation: Invalidation = {
  kind: "entity",
  ref: { type: "User", id: "u1" },
  paths: [[{ field: "online" }]],
};

export const addCommentOperation: typeof api.comment.add = api.comment.add;

export const toggleUserOperation: typeof api.userOnline.toggle = api.userOnline.toggle;

export function typecheckGQLensContract(q: QueryNode): void {
  void q.viewer.name;
  void q.user({ id: "u1" }).posts.ids;
  void api.comment.add.variables({ postId: "p1", body: "hello" });

  // @ts-expect-error Generated nodes only expose fields from the GraphQL schema.
  void q.viewer.email;

  // @ts-expect-error Query user requires its non-null id argument.
  void q.user({}).name;

  // @ts-expect-error Mutation addComment requires both postId and body.
  void api.comment.add.variables({ postId: "p1" });

  // @ts-expect-error Mutation groups are generated from schema field names.
  void api.user.toggle;
}

export async function createBrowserPersistedRecords() {
  return createIndexedDBGraphDataRecords();
}

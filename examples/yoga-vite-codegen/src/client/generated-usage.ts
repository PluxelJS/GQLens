import type { MutationOperation, PreparedSelection } from "@gqlens/core";
import { api, defineInvalidation, defineSelection, type QueryNode } from "../gqlens/accessor";
import type { InvalidationSpec } from "../gqlens/invalidation";
import type * as Types from "../gqlens/types";

export function readGeneratedAccessor(q: QueryNode): {
  readonly viewerName: Types.User["name"] | undefined;
  readonly userIds: readonly string[] | undefined;
  readonly postCommentIds: readonly string[] | undefined;
} {
  return {
    viewerName: q.viewer.name,
    userIds: q.users.ids,
    postCommentIds: q.post({ id: "p1" }).comments.ids,
  };
}

export const userCardSelection: PreparedSelection = defineSelection((q, v) => {
  void q.user({ id: v("userId") }).name;
  void q.user({ id: v("userId") }).posts.ids;
});

export const commentsInvalidation = defineInvalidation((q) => q.post({ id: "p1" }).comments.ids);

export const typedInvalidation: InvalidationSpec = {
  type: "User",
  id: "u1",
  keys: ["online"],
};

export const addCommentOperation: MutationOperation<Types.MutationAddCommentArgs, Types.Comment> =
  api.comment.add;

export const toggleUserOperation: MutationOperation<
  Types.MutationToggleUserOnlineArgs,
  Types.User
> = api.userOnline.toggle;

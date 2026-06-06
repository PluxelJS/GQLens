import type { InvalidationTarget, MutationOperation, PreparedSelection } from "@gqlens/core";
import type { NormalizerEntry } from "@gqlens/core/codegen";
import {
  api,
  defineInvalidation,
  defineSelection,
  useLiveQuery,
  useQuery,
  type PetNode,
  type QueryNode,
} from "./accessor";
import type { InvalidationSpec } from "./invalidation";
import { normalizerEntries } from "./normalizer";
import type * as Types from "./types";

export function readAccessor(q: QueryNode): {
  readonly name: Types.User["name"] | undefined;
  readonly postIds: readonly string[] | undefined;
  readonly searchRefs: readonly { readonly type: string; readonly id: string }[] | undefined;
  readonly catMeows: Types.Cat["meows"] | undefined;
} {
  const user = q.user({ id: "user-1" });
  const postIds = user.posts.ids;
  const searchRefs = q.search({ text: "hello" }).refs;
  const catMeows = q.pet({ id: "pet-1" }).$on.Cat.meows;

  return {
    name: user.name,
    postIds,
    searchRefs,
    catMeows,
  };
}

export const staticSelection: PreparedSelection = defineSelection((q, v) => {
  void q.user({ id: v("userId") }).name;
  void q.posts({ first: v("limit"), done: false }).ids;
  void q.pet({ id: v("petId") }).$on.Dog.barks;
  void q.search({ text: v("text") }).refs;
});

export const invalidation: InvalidationTarget = defineInvalidation(
  (q) => q.user({ id: "user-1" }).posts.ids,
);

export const typedInvalidation: InvalidationSpec = {
  type: "User",
  id: "user-1",
  keys: ["name", "avatar"],
};

export const renameUser: MutationOperation<Types.MutationRenameUserArgs, Types.User> =
  api.user.rename;

export const addComment: MutationOperation<Types.MutationAddCommentArgs, Types.Comment> =
  api.comment.add;

export const runtimeAccessors: {
  readonly query: typeof useQuery;
  readonly liveQuery: typeof useLiveQuery;
} = {
  query: useQuery,
  liveQuery: useLiveQuery,
};

export const generatedNormalizerEntries: readonly NormalizerEntry[] = normalizerEntries;

export function readPet(pet: PetNode): Types.Pet["name"] | undefined {
  return pet.name;
}

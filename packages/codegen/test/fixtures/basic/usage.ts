import type { GraphDataInvalidation, MutationOperation, PreparedSelection } from "@gqlens/core";
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
import type { Invalidation } from "./invalidation";
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

export const invalidation: GraphDataInvalidation = defineInvalidation(
  (q) => q.user({ id: "user-1" }).posts.ids,
);

export const typedInvalidation: Invalidation = {
  kind: "entity",
  ref: { type: "User", id: "user-1" },
  paths: [[{ field: "name" }], [{ field: "avatar" }]],
};

export const renameUser: MutationOperation<
  Types.MutationRenameUserArgs,
  Pick<
    NonNullable<Types.Mutation["renameUser"]>,
    "id" | "__typename" | "name" | "avatar" | "online"
  >
> = api.user.rename;

export const addComment: MutationOperation<
  Types.MutationAddCommentArgs,
  Pick<NonNullable<Types.Mutation["addComment"]>, "id" | "__typename" | "body">
> = api.comment.add;

export const runtimeAccessors: {
  readonly query: typeof useQuery;
  readonly liveQuery: typeof useLiveQuery;
} = {
  query: useQuery,
  liveQuery: useLiveQuery,
};

export function refetchQuery(q: ReturnType<typeof useQuery>): void {
  q.refetch();
}

export const generatedNormalizerEntries: readonly NormalizerEntry[] = normalizerEntries;

export function readPet(pet: PetNode): Types.Pet["name"] | undefined {
  return pet.name;
}

export function rejectUnsupportedAccessorShapes(q: QueryNode): void {
  // @ts-expect-error Query user requires its non-null id argument.
  q.user({});

  // @ts-expect-error Generated nodes only expose schema fields.
  void q.viewer.missingField;

  // @ts-expect-error Ordinary entity lists expose ids, not refs.
  void q.viewer.posts.refs;

  // @ts-expect-error Abstract lists expose refs, not ids.
  void q.search({ text: "text" }).ids;
}

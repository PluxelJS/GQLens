import { createRequire } from "node:module";
import {
  type GraphQLObjectType as GraphQLObjectTypeValue,
  type GraphQLSchema as GraphQLSchemaValue,
} from "graphql";
import type { AppContext } from "./context";
import type { ExampleComment, ExamplePost, ExampleUser } from "./db";

const require = createRequire(import.meta.url);
const {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  printSchema,
} = require("graphql") as typeof import("graphql");

const RoleType = new GraphQLEnumType({
  name: "Role",
  values: {
    ADMIN: { value: "admin" },
    MEMBER: { value: "member" },
  },
});

let UserType: GraphQLObjectTypeValue<ExampleUser, AppContext>;
let PostType: GraphQLObjectTypeValue<ExamplePost, AppContext>;
let CommentType: GraphQLObjectTypeValue<ExampleComment, AppContext>;

UserType = new GraphQLObjectType<ExampleUser, AppContext>({
  name: "User",
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    role: { type: new GraphQLNonNull(RoleType) },
    online: { type: new GraphQLNonNull(GraphQLBoolean) },
    posts: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PostType))),
      resolve: (user, _args, context) => context.services.postsByAuthor(user.id),
    },
  }),
});

PostType = new GraphQLObjectType<ExamplePost, AppContext>({
  name: "Post",
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    body: { type: new GraphQLNonNull(GraphQLString) },
    author: {
      type: new GraphQLNonNull(UserType),
      resolve: (post, _args, context) => context.services.user(post.authorId),
    },
    comments: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CommentType))),
      resolve: (post, _args, context) => context.services.commentsByPost(post.id),
    },
  }),
});

CommentType = new GraphQLObjectType<ExampleComment, AppContext>({
  name: "Comment",
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    body: { type: new GraphQLNonNull(GraphQLString) },
    author: {
      type: new GraphQLNonNull(UserType),
      resolve: (comment, _args, context) => context.services.user(comment.authorId),
    },
  }),
});

export function createSchema(): GraphQLSchemaValue {
  const QueryType = new GraphQLObjectType<unknown, AppContext>({
    name: "Query",
    fields: {
      viewer: {
        type: new GraphQLNonNull(UserType),
        resolve: (_source, _args, context) => context.services.viewer(),
      },
      user: {
        type: UserType,
        args: {
          id: { type: new GraphQLNonNull(GraphQLID) },
        },
        resolve: (_source, args: { readonly id: string }, context) =>
          context.services.user(args.id),
      },
      users: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(UserType))),
        resolve: (_source, _args, context) => context.services.users(),
      },
      post: {
        type: PostType,
        args: {
          id: { type: new GraphQLNonNull(GraphQLID) },
        },
        resolve: (_source, args: { readonly id: string }, context) =>
          context.services.post(args.id),
      },
      posts: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PostType))),
        resolve: (_source, _args, context) => context.services.posts(),
      },
    },
  });

  const MutationType = new GraphQLObjectType<unknown, AppContext>({
    name: "Mutation",
    fields: {
      renameUser: {
        type: new GraphQLNonNull(UserType),
        args: {
          id: { type: new GraphQLNonNull(GraphQLID) },
          name: { type: new GraphQLNonNull(GraphQLString) },
        },
        resolve: (_source, args: { readonly id: string; readonly name: string }, context) =>
          context.services.renameUser(args.id, args.name),
      },
      toggleUserOnline: {
        type: new GraphQLNonNull(UserType),
        args: {
          id: { type: new GraphQLNonNull(GraphQLID) },
        },
        resolve: (_source, args: { readonly id: string }, context) =>
          context.services.toggleUserOnline(args.id),
      },
      addComment: {
        type: new GraphQLNonNull(CommentType),
        args: {
          postId: { type: new GraphQLNonNull(GraphQLID) },
          body: { type: new GraphQLNonNull(GraphQLString) },
        },
        resolve: (_source, args: { readonly postId: string; readonly body: string }, context) =>
          context.services.addComment(args.postId, args.body),
      },
    },
  });

  return new GraphQLSchema({
    query: QueryType,
    mutation: MutationType,
  });
}

export function createSchemaSDL(): string {
  return printSchema(createSchema());
}

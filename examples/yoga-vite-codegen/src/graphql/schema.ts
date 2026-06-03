import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from "graphql";

const users = [
  {
    id: "1",
    name: "Ada Lovelace",
    online: true,
  },
  {
    id: "2",
    name: "Grace Hopper",
    online: false,
  },
] as const;

const UserType = new GraphQLObjectType({
  name: "User",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    online: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

export function createSchema(): GraphQLSchema {
  const QueryType = new GraphQLObjectType({
    name: "Query",
    fields: {
      viewer: {
        type: UserType,
        resolve: () => users[0],
      },
      user: {
        type: UserType,
        args: {
          id: { type: new GraphQLNonNull(GraphQLID) },
        },
        resolve: (_source, args: { readonly id: string }) =>
          users.find((user) => user.id === args.id) ?? null,
      },
      users: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(UserType))),
        resolve: () => users,
      },
    },
  });

  return new GraphQLSchema({
    query: QueryType,
  });
}

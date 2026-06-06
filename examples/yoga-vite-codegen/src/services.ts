import type { db, ExampleComment, ExamplePost, ExampleUser } from "./db";

export function createServices(database: typeof db) {
  return {
    health() {
      return {
        dbStartedAt: database.startedAt,
      };
    },

    viewer(): ExampleUser {
      return database.users[0]!;
    },

    user(id: string): ExampleUser | null {
      return database.users.find((user) => user.id === id) ?? null;
    },

    users(): readonly ExampleUser[] {
      return database.users;
    },

    post(id: string): ExamplePost | null {
      return database.posts.find((post) => post.id === id) ?? null;
    },

    posts(): readonly ExamplePost[] {
      return database.posts;
    },

    postsByAuthor(authorId: string): readonly ExamplePost[] {
      return database.posts.filter((post) => post.authorId === authorId);
    },

    commentsByPost(postId: string): readonly ExampleComment[] {
      return database.comments.filter((comment) => comment.postId === postId);
    },

    renameUser(id: string, name: string): ExampleUser {
      const user = mustFind(database.users, id, "User");
      user.name = name;
      return user;
    },

    toggleUserOnline(id: string): ExampleUser {
      const user = mustFind(database.users, id, "User");
      user.online = !user.online;
      return user;
    },

    addComment(postId: string, body: string): ExampleComment {
      const viewer = database.users[0]!;
      mustFind(database.posts, postId, "Post");

      const comment = {
        id: `c${database.nextCommentId++}`,
        postId,
        authorId: viewer.id,
        body,
      };
      database.comments.push(comment);
      return comment;
    },
  };
}

function mustFind<T extends { readonly id: string }>(
  records: readonly T[],
  id: string,
  typeName: string,
): T {
  const record = records.find((item) => item.id === id);
  if (!record) {
    throw new Error(`${typeName} not found: ${id}`);
  }
  return record;
}

export interface ExampleUser {
  readonly id: string;
  name: string;
  readonly role: "admin" | "member";
  online: boolean;
}

export interface ExamplePost {
  readonly id: string;
  readonly authorId: string;
  title: string;
  body: string;
}

export interface ExampleComment {
  readonly id: string;
  readonly postId: string;
  readonly authorId: string;
  body: string;
}

interface ExampleDb {
  readonly startedAt: number;
  readonly users: ExampleUser[];
  readonly posts: ExamplePost[];
  readonly comments: ExampleComment[];
  nextCommentId: number;
}

declare global {
  var __gqlens_example_db__: ExampleDb | undefined;
}

function createInitialDb(): ExampleDb {
  return {
    startedAt: Date.now(),
    users: [
      { id: "u1", name: "Ada Lovelace", role: "admin", online: true },
      { id: "u2", name: "Grace Hopper", role: "member", online: false },
      { id: "u3", name: "Katherine Johnson", role: "member", online: true },
    ],
    posts: [
      {
        id: "p1",
        authorId: "u1",
        title: "Generated accessors",
        body: "Fields are read from a schema-generated contract.",
      },
      {
        id: "p2",
        authorId: "u2",
        title: "Normalized cache",
        body: "Entity fields are cached by typename and id.",
      },
    ],
    comments: [
      { id: "c1", postId: "p1", authorId: "u2", body: "The accessor shape is easy to inspect." },
      { id: "c2", postId: "p1", authorId: "u3", body: "The same schema drives the UI types." },
    ],
    nextCommentId: 3,
  };
}

const existing = globalThis.__gqlens_example_db__;

export const db: ExampleDb = existing ?? createInitialDb();

if (process.env.NODE_ENV !== "production") {
  globalThis.__gqlens_example_db__ = db;
}

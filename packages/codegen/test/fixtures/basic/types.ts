export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
};

export type Node = {
  id: Scalars['ID']['output'];
};

export type User = Node & {
  __typename?: 'User';
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  avatar?: Maybe<Scalars['String']['output']>;
  online: Scalars['Boolean']['output'];
  posts: Array<Post>;
};

export type Post = Node & {
  __typename?: 'Post';
  id: Scalars['ID']['output'];
  title: Scalars['String']['output'];
  content: Scalars['String']['output'];
  tags: Array<Scalars['String']['output']>;
  author: User;
  comments: Array<Comment>;
};

export type Comment = {
  __typename?: 'Comment';
  id: Scalars['ID']['output'];
  body: Scalars['String']['output'];
  author: User;
};

export type Pet = {
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
};

export type Cat = Pet & {
  __typename?: 'Cat';
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  meows: Scalars['Boolean']['output'];
};

export type Dog = Pet & {
  __typename?: 'Dog';
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  barks: Scalars['Boolean']['output'];
};

export type SearchResult = User | Post;

export type Query = {
  __typename?: 'Query';
  user?: Maybe<User>;
  viewer?: Maybe<User>;
  post?: Maybe<Post>;
  posts: Array<Post>;
  pet?: Maybe<Pet>;
  search: Array<SearchResult>;
};


export type QueryUserArgs = {
  id: Scalars['ID']['input'];
};


export type QueryPostArgs = {
  id: Scalars['ID']['input'];
};


export type QueryPostsArgs = {
  first?: InputMaybe<Scalars['Int']['input']>;
  done?: InputMaybe<Scalars['Boolean']['input']>;
};


export type QueryPetArgs = {
  id: Scalars['ID']['input'];
};


export type QuerySearchArgs = {
  text: Scalars['String']['input'];
};

export type Mutation = {
  __typename?: 'Mutation';
  renameUser: User;
  addComment: Comment;
};


export type MutationRenameUserArgs = {
  id: Scalars['ID']['input'];
  name: Scalars['String']['input'];
};


export type MutationAddCommentArgs = {
  postId: Scalars['ID']['input'];
  content: Scalars['String']['input'];
};

export type Status =
  | 'ACTIVE'
  | 'INACTIVE';

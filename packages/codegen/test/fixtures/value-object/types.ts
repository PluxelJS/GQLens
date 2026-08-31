export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
};

export type User = {
  __typename?: 'User';
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  status: UserStatus;
};

export type UserStatus = {
  __typename?: 'UserStatus';
  online: Scalars['Boolean']['output'];
  source: StatusSource;
};

export type StatusSource = {
  __typename?: 'StatusSource';
  kind: Scalars['String']['output'];
  version?: Maybe<Scalars['String']['output']>;
};

export type PluginStatus = {
  __typename?: 'PluginStatus';
  summary: PluginSummary;
};

export type PluginSummary = {
  __typename?: 'PluginSummary';
  total: Scalars['Int']['output'];
};

export type Query = {
  __typename?: 'Query';
  user?: Maybe<User>;
  pluginStatus: PluginStatus;
};


export type QueryUserArgs = {
  id: Scalars['ID']['input'];
};

export type Mutation = {
  __typename?: 'Mutation';
  renameUser: User;
};


export type MutationRenameUserArgs = {
  id: Scalars['ID']['input'];
  name: Scalars['String']['input'];
};

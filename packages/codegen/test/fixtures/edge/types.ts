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
  DateTime: { input: any; output: any; }
};

export type SortOrder =
  | 'ASC'
  | 'DESC';

export type RangeInput = {
  from?: InputMaybe<Scalars['DateTime']['input']>;
  to?: InputMaybe<Scalars['DateTime']['input']>;
};

export type SearchFilter = {
  text?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  range?: InputMaybe<RangeInput>;
  order?: InputMaybe<SortOrder>;
};

export type Report = {
  __typename?: 'Report';
  id: Scalars['ID']['output'];
  title: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
};

export type AuditEvent = {
  __typename?: 'AuditEvent';
  id: Scalars['ID']['output'];
  message: Scalars['String']['output'];
};

export type Query = {
  __typename?: 'Query';
  reports: Array<Report>;
  latestReport?: Maybe<Report>;
};


export type QueryReportsArgs = {
  filter?: InputMaybe<SearchFilter>;
  ids?: InputMaybe<Array<Scalars['ID']['input']>>;
  limit?: InputMaybe<Scalars['Int']['input']>;
};

export type Mutation = {
  __typename?: 'Mutation';
  ping: Scalars['Boolean']['output'];
  rebuildIndex: Scalars['Boolean']['output'];
  renameReport: Report;
  createAudit: AuditEvent;
};


export type MutationRenameReportArgs = {
  id: Scalars['ID']['input'];
  title: Scalars['String']['input'];
};


export type MutationCreateAuditArgs = {
  message: Scalars['String']['input'];
};

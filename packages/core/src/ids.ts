import { ulid } from 'ulid';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProjectId = Brand<string, 'ProjectId'>;
export type RepoId = Brand<string, 'RepoId'>;
export type WorktreeId = Brand<string, 'WorktreeId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type TargetId = Brand<string, 'TargetId'>;
export type GrantId = Brand<string, 'GrantId'>;
export type AuditId = Brand<string, 'AuditId'>;
export type PolicyId = Brand<string, 'PolicyId'>;
export type AskId = Brand<string, 'AskId'>;
export type HunkId = Brand<string, 'HunkId'>;
export type MessageId = Brand<string, 'MessageId'>;

export const newId = <T extends string>(): Brand<string, T> => ulid() as Brand<string, T>;

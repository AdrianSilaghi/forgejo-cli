import type { AuthenticatedUser } from "../auth/auth-service.js";
import type { TokenReadOptions } from "../auth/token-input.js";
import type { AccountMetadata } from "../config/config-repository.js";
import type { IssueOperations } from "../forgejo/issue-service.js";
import type { LabelOperations } from "../forgejo/label-service.js";
import type { MilestoneOperations } from "../forgejo/milestone-service.js";
import type { PullRequestOperations } from "../forgejo/pull-request-service.js";
import type { ReleaseOperations } from "../forgejo/release-service.js";
import type { RepositoryOperations, RepositoryRef } from "../forgejo/repository-service.js";

export type RepositorySelection = Readonly<{
  host?: string;
  repository?: RepositoryRef;
  remote?: string;
  username?: string;
}>;

export type ResolvedRepository<T extends Readonly<Record<string, unknown>>> = Readonly<{
  origin: string;
  repository: RepositoryRef;
  localBranch: string | null;
  services: T;
}>;

export type RepositoryDetection = Readonly<{
  origin: string;
  repository: RepositoryRef;
  localBranch: string | null;
}>;

export interface RepositoryCommandRuntime<T extends Readonly<Record<string, unknown>>> {
  resolve(selection: RepositorySelection): Promise<ResolvedRepository<T>>;
}

export interface AuthCommandRuntime {
  readToken(options: TokenReadOptions): Promise<string>;
  login(input: {
    host: string;
    token: string;
  }): Promise<Readonly<{ origin: string; user: AuthenticatedUser }>>;
  list(): Promise<readonly AccountMetadata[]>;
  status(input: { host?: string }): Promise<Readonly<Record<string, unknown>>>;
  logout(input: { host: string; username?: string }): Promise<Readonly<Record<string, unknown>>>;
}

export type RepositoryServices = Readonly<{
  repositories: RepositoryOperations;
}>;

export type PullRequestServices = Readonly<{
  repositories: RepositoryOperations;
  pullRequests: PullRequestOperations;
}>;

export type IssueServices = Readonly<{
  issues: IssueOperations;
}>;

export type LabelServices = Readonly<{
  labels: LabelOperations;
}>;

export type MilestoneServices = Readonly<{
  milestones: MilestoneOperations;
}>;

export type ReleaseServices = Readonly<{
  releases: ReleaseOperations;
}>;

import type { ResolvedAccount } from "../auth/account-resolver.js";
import type { ForgejoEnvironment } from "../auth/account-resolver.js";
import type { IssueOperations } from "../forgejo/issue-service.js";
import type { LabelOperations } from "../forgejo/label-service.js";
import type { MilestoneOperations } from "../forgejo/milestone-service.js";
import type { PullRequestOperations } from "../forgejo/pull-request-service.js";
import type { ReleaseOperations } from "../forgejo/release-service.js";
import type { RepositoryOperations } from "../forgejo/repository-service.js";
import type { RepositoryContext } from "../git/repository-context.js";
import { compactDefined } from "./command-options.js";
import type {
  RepositoryDetection,
  RepositorySelection,
  ResolvedRepository,
} from "./command-runtime.js";

export type ForgejoServiceBundle = Readonly<{
  repositories: RepositoryOperations;
  pullRequests: PullRequestOperations;
  issues: IssueOperations;
  labels: LabelOperations;
  milestones: MilestoneOperations;
  releases: ReleaseOperations;
}>;

export interface RepositoryContextPort {
  resolve(input: {
    cwd?: string;
    repository?: string;
    host?: string;
    remote?: string;
  }): Promise<RepositoryContext>;
}

export interface AccountResolutionPort {
  resolve(input: {
    origin: string;
    explicitHost?: string;
    username?: string;
    environment: ForgejoEnvironment;
  }): Promise<ResolvedAccount>;
}

export interface BranchResolutionPort {
  current(cwd: string): Promise<string | null>;
}

export type RepositorySessionFactoryOptions = Readonly<{
  cwd: string;
  environment: ForgejoEnvironment;
  contexts: RepositoryContextPort;
  accounts: AccountResolutionPort;
  branches: BranchResolutionPort;
  serviceFactory(origin: string, token: string): ForgejoServiceBundle;
}>;

export class RepositorySessionFactory {
  readonly #cwd: string;
  readonly #environment: ForgejoEnvironment;
  readonly #contexts: RepositoryContextPort;
  readonly #accounts: AccountResolutionPort;
  readonly #branches: BranchResolutionPort;
  readonly #serviceFactory: RepositorySessionFactoryOptions["serviceFactory"];

  public constructor(options: RepositorySessionFactoryOptions) {
    this.#cwd = options.cwd;
    this.#environment = Object.freeze({ ...options.environment });
    this.#contexts = options.contexts;
    this.#accounts = options.accounts;
    this.#branches = options.branches;
    this.#serviceFactory = options.serviceFactory;
  }

  public async detect(selection: RepositorySelection): Promise<RepositoryDetection> {
    const environmentHost = this.#environment.FORGEJO_HOST;
    const context = await this.#contexts.resolve(
      compactDefined({
        cwd: this.#cwd,
        repository:
          selection.repository === undefined
            ? undefined
            : `${selection.repository.owner}/${selection.repository.repository}`,
        host: selection.host ?? environmentHost,
        remote: selection.remote,
      }),
    );
    const localBranch = await this.#branches.current(this.#cwd);
    return Object.freeze({
      origin: context.origin,
      repository: Object.freeze({
        owner: context.owner,
        repository: context.repository,
      }),
      localBranch,
    });
  }

  public async resolve(
    selection: RepositorySelection,
  ): Promise<ResolvedRepository<ForgejoServiceBundle>> {
    const detected = await this.detect(selection);
    const account = await this.#accounts.resolve(
      compactDefined({
        origin: detected.origin,
        explicitHost: selection.host,
        username: selection.username,
        environment: this.#environment,
      }) as {
        origin: string;
        explicitHost?: string;
        username?: string;
        environment: ForgejoEnvironment;
      },
    );
    return Object.freeze({
      ...detected,
      services: Object.freeze(this.#serviceFactory(account.origin, account.token)),
    });
  }
}

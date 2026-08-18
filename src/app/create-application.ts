import type { Readable } from "node:stream";

import { AccountResolver, type ForgejoEnvironment } from "../auth/account-resolver.js";
import { AuthService } from "../auth/auth-service.js";
import { PlatformCredentialStore } from "../auth/platform-credential-store.js";
import { ReadlineHiddenTokenPrompt, SecureTokenInput } from "../auth/token-input.js";
import { BunAssetFileSource } from "../cli/asset-file.js";
import { AuthCommandRuntimeAdapter } from "../cli/auth-command-runtime.js";
import { buildProgram, type BuildProgramDependencies } from "../cli/build-program.js";
import { RepositorySessionFactory } from "../cli/repository-session-factory.js";
import { ConfigRepository } from "../config/config-repository.js";
import { resolveConfigPath } from "../config/paths.js";
import { IssueService } from "../forgejo/issue-service.js";
import { LabelService } from "../forgejo/label-service.js";
import { MilestoneService } from "../forgejo/milestone-service.js";
import { PullRequestService } from "../forgejo/pull-request-service.js";
import { ReleaseService } from "../forgejo/release-service.js";
import { RepositoryService } from "../forgejo/repository-service.js";
import { LocalGitBranchReader } from "../git/local-git-branch-reader.js";
import { LocalGitRepositoryReader } from "../git/local-git-repository-reader.js";
import { RepositoryContextResolver } from "../git/repository-context.js";
import { ForgejoHttpClient } from "../http/forgejo-http-client.js";

export type ApplicationOptions = Readonly<{
  cwd?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  stdin?: Readable;
}>;

function serviceBundle(origin: string, token: string) {
  const api = new ForgejoHttpClient({ origin, token });
  return Object.freeze({
    repositories: new RepositoryService(api),
    pullRequests: new PullRequestService(api),
    issues: new IssueService(api),
    labels: new LabelService(api),
    milestones: new MilestoneService(api),
    releases: new ReleaseService(api, api),
  });
}

export function createApplicationDependencies(
  options: ApplicationOptions = {},
): BuildProgramDependencies {
  const environment: ForgejoEnvironment = Object.freeze({
    ...(options.environment ?? process.env),
  });
  const stdin = options.stdin ?? process.stdin;
  const tokenInput = new SecureTokenInput({
    stream: stdin,
    prompt: new ReadlineHiddenTokenPrompt({ input: stdin, output: process.stderr }),
  });
  const config = new ConfigRepository(resolveConfigPath(environment));
  const credentials = new PlatformCredentialStore();
  const auth = new AuthService({
    credentials,
    accounts: config,
    clientFactory: (origin, token) => new ForgejoHttpClient({ origin, token }),
  });
  const session = new RepositorySessionFactory({
    cwd: options.cwd ?? process.cwd(),
    environment,
    contexts: new RepositoryContextResolver({
      git: new LocalGitRepositoryReader(),
      accounts: config,
    }),
    accounts: new AccountResolver({ accounts: config, credentials }),
    branches: new LocalGitBranchReader(),
    serviceFactory: serviceBundle,
  });
  const resolve = session.resolve.bind(session);
  const detect = session.detect.bind(session);
  const files = new BunAssetFileSource();

  return Object.freeze({
    auth: new AuthCommandRuntimeAdapter({ auth, credentials, environment, tokenInput }),
    repository: Object.freeze({ resolve, detect }),
    pullRequests: Object.freeze({ resolve, stdin }),
    issues: Object.freeze({ resolve, stdin }),
    labels: Object.freeze({ resolve }),
    milestones: Object.freeze({ resolve }),
    releases: Object.freeze({ resolve, stdin, files }),
  });
}

export function createApplicationProgram(options: ApplicationOptions = {}) {
  return buildProgram(createApplicationDependencies(options));
}

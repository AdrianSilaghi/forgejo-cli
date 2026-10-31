import type { Command } from "commander";
import { compactDefined } from "../cli/command-options.js";
import type { RepositoryCommandRuntime } from "../cli/command-runtime.js";
import { returnResult } from "../cli/execute.js";
import {
  type PollingRuntime,
  pollingOptions,
  pollUntil,
  type RawPollingOptions,
} from "../cli/polling.js";
import type {
  PullRequestChecks,
  PullRequestChecksOperations,
} from "../forgejo/pull-request-checks-service.js";
import type { PullRequestOperations } from "../forgejo/pull-request-service.js";
import { resolvePullRequestSelector } from "./pull-request-selector.js";
import { selectionFor } from "./repository-command.js";

export type PullRequestChecksServices = Readonly<{
  pullRequests: PullRequestOperations;
  pullRequestChecks: PullRequestChecksOperations;
}>;
type Runtime = RepositoryCommandRuntime<PullRequestChecksServices> &
  Readonly<{ progress?: (text: string) => void; polling?: PollingRuntime }>;
function summary(result: PullRequestChecks): string {
  const items = [
    ...result.checks.map((check) => `${check.context}: ${check.state}`),
    ...result.workflows.map((run) => `${run.workflow} #${run.number}: ${run.status}`),
  ];
  return [
    `PR #${result.pull_request} (${result.head_sha}): ${result.state}`,
    ...items,
    "Observed CI only; required-check and merge readiness are not evaluated.",
  ].join("\n");
}
export function registerPrChecksCommands(program: Command, runtime: Runtime): void {
  const pr = program.commands.find((command) => command.name() === "pr");
  if (pr === undefined) throw new Error("Register pull request commands before checks.");
  pr.command("checks [selector]")
    .description("Inspect CI on the exact PR head; does not evaluate required-check readiness")
    .option("--watch", "Watch until observed checks complete")
    .option("--workflow <file>", "Inspect only this workflow file")
    .option("--interval <seconds>", "Poll interval in seconds (maximum 3600)", "3")
    .option("--timeout <seconds>", "Watch timeout in seconds (maximum 86400)", "300")
    .action(
      async (
        selector: string | undefined,
        options: RawPollingOptions & { watch?: boolean; workflow?: string },
        command: Command,
      ) => {
        const polling = pollingOptions(options);
        const resolved = await runtime.resolve(selectionFor(command));
        const number = await resolvePullRequestSelector(selector, resolved);
        let headSha: string | undefined;
        const load = async (signal?: AbortSignal) => {
          const snapshot = await resolved.services.pullRequestChecks.snapshot(
            resolved.repository,
            number,
            compactDefined({ workflow: options.workflow, expectedHeadSha: headSha }),
            signal,
          );
          headSha ??= snapshot.head_sha;
          return snapshot;
        };
        const result = options.watch
          ? await pollUntil(
              load,
              (snapshot) => snapshot.state !== "pending",
              polling,
              runtime.polling,
              (snapshot) =>
                runtime.progress?.(`PR #${number} (${snapshot.head_sha}): ${snapshot.state}`),
            )
          : await load(runtime.polling?.signal);
        returnResult(
          result,
          summary(result),
          result.state === "failure" ? 10 : result.state === "pending" ? 11 : 0,
        );
      },
    );
}

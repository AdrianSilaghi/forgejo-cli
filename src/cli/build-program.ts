import { Command } from "commander";

import { registerArtifactCommands } from "../commands/artifact-commands.js";
import { registerAuthCommands } from "../commands/auth-commands.js";
import { registerIssueCommands } from "../commands/issue-commands.js";
import { registerLabelCommands } from "../commands/label-commands.js";
import { registerMilestoneCommands } from "../commands/milestone-commands.js";
import { registerPullRequestCommands } from "../commands/pull-request-commands.js";
import { registerReleaseCommands } from "../commands/release-commands.js";
import { registerRepositoryCommands } from "../commands/repository-commands.js";
import { registerRunCommands } from "../commands/run-commands.js";
import { registerWorkflowCommands } from "../commands/workflow-commands.js";

export type BuildProgramDependencies = Readonly<{
  auth: Parameters<typeof registerAuthCommands>[1];
  repository: Parameters<typeof registerRepositoryCommands>[1];
  pullRequests: Parameters<typeof registerPullRequestCommands>[1];
  issues: Parameters<typeof registerIssueCommands>[1];
  labels: Parameters<typeof registerLabelCommands>[1];
  milestones: Parameters<typeof registerMilestoneCommands>[1];
  releases: Parameters<typeof registerReleaseCommands>[1];
  runs: Parameters<typeof registerRunCommands>[1];
  workflows: Parameters<typeof registerWorkflowCommands>[1];
  artifacts: Parameters<typeof registerArtifactCommands>[1];
}>;

export function buildProgram(dependencies: BuildProgramDependencies): Command {
  const program = new Command()
    .name("forgejo")
    .description("Agent-first, JSON-first CLI for Forgejo")
    .version("0.0.1")
    .option("--host <url>", "Exact Forgejo origin")
    .option("-R, --repo <owner/repository>", "Explicit repository")
    .option("--remote <name>", "Local Git remote to inspect", "origin")
    .option("--account <username>", "Configured account username")
    .option("--human", "Render human-readable output instead of JSON");

  registerAuthCommands(program, dependencies.auth);
  registerRepositoryCommands(program, dependencies.repository);
  registerPullRequestCommands(program, dependencies.pullRequests);
  registerIssueCommands(program, dependencies.issues);
  registerLabelCommands(program, dependencies.labels);
  registerMilestoneCommands(program, dependencies.milestones);
  registerReleaseCommands(program, dependencies.releases);
  registerRunCommands(program, dependencies.runs);
  registerWorkflowCommands(program, dependencies.workflows);
  registerArtifactCommands(program, dependencies.artifacts);
  return program;
}

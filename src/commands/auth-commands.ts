import type { Command } from "commander";

import { CliError } from "../core/errors.js";
import type { AuthCommandRuntime } from "../cli/command-runtime.js";
import { returnJson } from "../cli/execute.js";
import { normalizeOrigin } from "../http/origin.js";

type HostOptions = Readonly<{ host?: string; withToken?: boolean }>;

function hostOption(options: HostOptions, command: Command): string | undefined {
  return options.host ?? (command.optsWithGlobals() as HostOptions).host;
}

function requiredHost(options: HostOptions, command: Command): string {
  const host = hostOption(options, command);
  if (host === undefined) {
    throw new CliError("validation_failed", "The --host option is required.");
  }
  return normalizeOrigin(host);
}

export function registerAuthCommands(program: Command, runtime: AuthCommandRuntime): void {
  const auth = program.command("auth").description("Manage Forgejo authentication");

  auth
    .command("login")
    .description("Validate and securely store a personal access token")
    .option("--host <url>", "Exact Forgejo origin")
    .option("--with-token", "Read one personal access token from piped stdin")
    .action(async (options: HostOptions, command: Command) => {
      const host = requiredHost(options, command);
      const token = await runtime.readToken({ pipedOnly: options.withToken === true });
      returnJson(await runtime.login({ host, token }));
    });

  auth
    .command("status")
    .description("Show authentication status without revealing credentials")
    .option("--host <url>", "Exact Forgejo origin")
    .action(async (options: HostOptions, command: Command) => {
      const host = hostOption(options, command);
      returnJson(await runtime.status(host === undefined ? {} : { host }));
    });

  auth
    .command("list")
    .description("List configured accounts without revealing credentials")
    .action(async () => returnJson(await runtime.list()));

  auth
    .command("logout")
    .description("Remove a credential from the operating-system credential store")
    .option("--host <url>", "Exact Forgejo origin")
    .option("--user <username>", "Account username when more than one account exists")
    .action(async (options: HostOptions & Readonly<{ user?: string }>, command: Command) => {
      const host = requiredHost(options, command);
      returnJson(
        await runtime.logout(
          options.user === undefined ? { host } : { host, username: options.user },
        ),
      );
    });
}

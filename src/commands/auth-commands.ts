import type { Command } from "commander";

import type { AuthCommandRuntime } from "../cli/command-runtime.js";
import { returnJson } from "../cli/execute.js";
import { readTokenFromStream } from "../auth/token-input.js";

export function registerAuthCommands(program: Command, runtime: AuthCommandRuntime): void {
  const auth = program.command("auth").description("Manage Forgejo authentication");

  auth
    .command("login")
    .description("Validate and securely store a personal access token from stdin")
    .requiredOption("--host <url>", "Exact Forgejo origin")
    .requiredOption("--with-token", "Read one personal access token from stdin")
    .action(async (options: { host: string }) => {
      const token = await readTokenFromStream(runtime.stdin);
      returnJson(await runtime.login({ host: options.host, token }));
    });

  auth
    .command("status")
    .description("Show authentication status without revealing credentials")
    .option("--host <url>", "Exact Forgejo origin")
    .action(async (options: { host?: string }) => {
      returnJson(await runtime.status(options.host === undefined ? {} : { host: options.host }));
    });

  auth
    .command("list")
    .description("List configured accounts without revealing credentials")
    .action(async () => returnJson(await runtime.list()));

  auth
    .command("logout")
    .description("Remove a credential from the operating-system credential store")
    .requiredOption("--host <url>", "Exact Forgejo origin")
    .option("--user <username>", "Account username when more than one account exists")
    .action(async (options: { host: string; user?: string }) => {
      returnJson(
        await runtime.logout(
          options.user === undefined
            ? { host: options.host }
            : { host: options.host, username: options.user },
        ),
      );
    });
}

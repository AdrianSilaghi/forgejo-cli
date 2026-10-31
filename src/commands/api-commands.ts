import type { Command } from "commander";
import type { RepositoryCommandRuntime } from "../cli/command-runtime.js";
import { returnJson } from "../cli/execute.js";
import { collectPages } from "../cli/pagination.js";
import { CliError } from "../core/errors.js";
import { type ApiOperations, apiPath, apiQuery } from "../forgejo/api-service.js";
import {
  paginationOptions,
  type RawPaginationOptions,
  withPaginationOptions,
} from "./pagination-options.js";
import { selectionFor } from "./repository-command.js";

export type ApiServices = Readonly<{ api: ApiOperations }>;
type ApiOptions = RawPaginationOptions & Readonly<{ query: readonly string[] }>;

export function registerApiCommands(
  program: Command,
  runtime: RepositoryCommandRuntime<ApiServices>,
): void {
  withPaginationOptions(
    program
      .command("api <endpoint>")
      .description("GET JSON from an API-relative endpoint on the authenticated Forgejo host")
      .option(
        "--query <key=value>",
        "Query parameter; repeat for more",
        (value: string, previous: readonly string[]) => [...previous, value],
        [],
      ),
  ).action(async (endpoint: string, options: ApiOptions, command: Command) => {
    apiPath(endpoint);
    const explicitPaging = [
      ...(command.getOptionValueSource("page") === "cli" ? [`page=${options.page}`] : []),
      ...(command.getOptionValueSource("limit") === "cli" ? [`limit=${options.limit}`] : []),
    ];
    const queryInput = [...options.query, ...explicitPaging];
    apiQuery(queryInput);
    const pagination = paginationOptions(options);
    if (pagination.paginate && pagination.maxItems === undefined)
      throw new CliError("validation_failed", "--paginate requires a positive --max-items bound.");
    if (
      (pagination.paginate || explicitPaging.length > 0) &&
      options.query.some((entry) => /^(page|limit)=/.test(entry))
    )
      throw new CliError(
        "validation_failed",
        "Use --page and --limit instead of conflicting pagination query parameters.",
      );
    const resolved = await runtime.resolve(selectionFor(command));
    if (!pagination.paginate) returnJson(await resolved.services.api.get(endpoint, queryInput));
    returnJson(
      await collectPages(async (page, limit) => {
        const response = await resolved.services.api.get(endpoint, [
          ...options.query,
          `page=${page}`,
          `limit=${limit}`,
        ]);
        if (!Array.isArray(response))
          throw new CliError("protocol_failed", "API pagination requires a JSON array response.");
        return response;
      }, pagination),
    );
  });
}

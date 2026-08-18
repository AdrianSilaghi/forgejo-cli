import { isAbsolute, join } from "node:path";

import { CliError } from "../core/errors.js";
import { hasControlCharacter } from "../core/text-validation.js";

type Environment = Readonly<{
  FORGEJO_CONFIG_PATH?: string;
  XDG_CONFIG_HOME?: string;
  HOME?: string;
  [key: string]: string | undefined;
}>;

function assertAbsolutePath(path: string, name: string): string {
  if (
    !isAbsolute(path) ||
    path.length > 4096 ||
    path.trim() !== path ||
    hasControlCharacter(path)
  ) {
    throw new CliError("config_failed", `${name} must be a safe absolute path.`);
  }
  return path;
}

export function resolveConfigPath(environment: Environment): string {
  const explicit = environment.FORGEJO_CONFIG_PATH;
  if (explicit !== undefined) return assertAbsolutePath(explicit, "FORGEJO_CONFIG_PATH");

  const xdg = environment.XDG_CONFIG_HOME;
  if (xdg !== undefined) {
    return join(assertAbsolutePath(xdg, "XDG_CONFIG_HOME"), "forgejo-cli", "config.json");
  }

  const home = environment.HOME;
  if (home !== undefined) {
    return join(assertAbsolutePath(home, "HOME"), ".config", "forgejo-cli", "config.json");
  }
  throw new CliError("config_failed", "Unable to determine the Forgejo CLI configuration path.");
}

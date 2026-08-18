export type GitCommandProcessEnvironment = Readonly<{
  PATH?: string;
  LANG?: string;
  LC_ALL?: string;
  [key: string]: string | undefined;
}>;

export function gitCommandEnvironment(
  environment: GitCommandProcessEnvironment,
): Readonly<Record<string, string>> {
  const path = environment.PATH;
  const language = environment.LANG;
  const locale = environment.LC_ALL;

  return Object.freeze({
    ...(path === undefined ? {} : { PATH: path }),
    ...(language === undefined ? {} : { LANG: language }),
    ...(locale === undefined ? {} : { LC_ALL: locale }),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  });
}

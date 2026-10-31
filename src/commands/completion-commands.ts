import type { Command } from "commander";
import { returnResult } from "../cli/execute.js";
import { CliError } from "../core/errors.js";

function completionWords(command: Command): readonly string[] {
  const names = [
    command.name(),
    ...command.aliases(),
    ...command.options.flatMap((option) =>
      [option.short, option.long].filter((flag): flag is string => flag !== undefined),
    ),
    "--help",
    "-h",
    ...command.commands.flatMap(completionWords),
  ];
  if (names.some((name) => !/^[A-Za-z0-9_-]+$/.test(name)))
    throw new CliError("validation_failed", "Command metadata is unsafe for shell completion.");
  return [...new Set(names)].sort();
}

export function generateCompletion(program: Command, shell: string): string {
  const words = completionWords(program);
  switch (shell) {
    case "bash":
      return `# Static Forgejo command and option completion\n_forgejo_cli_complete() {\n  local candidate\n  COMPREPLY=()\n  while IFS= read -r candidate; do\n    COMPREPLY+=("$candidate")\n  done < <(compgen -W '${words.join(" ")}' -- "\${COMP_WORDS[COMP_CWORD]}")\n}\ncomplete -F _forgejo_cli_complete forgejo forgejo-cli\n`;
    case "zsh":
      return `#compdef forgejo forgejo-cli\n_forgejo_cli_complete() {\n  local -a candidates\n  candidates=(${words.map((word) => `'${word}'`).join(" ")})\n  compadd -- "\${candidates[@]}"\n}\ncompdef _forgejo_cli_complete forgejo forgejo-cli\n`;
    case "fish":
      return `# Static Forgejo command and option completion\n${["forgejo", "forgejo-cli"].flatMap((name) => [`complete -c ${name} -f`, ...words.map((word) => (word.startsWith("--") ? `complete -c ${name} -l '${word.slice(2)}'` : word.startsWith("-") ? `complete -c ${name} -s '${word.slice(1)}'` : `complete -c ${name} -a '${word}'`))]).join("\n")}\n`;
    default:
      throw new CliError("validation_failed", "Supported completion shells: bash, zsh, fish.");
  }
}

export function registerCompletionCommands(program: Command): void {
  program
    .command("completion <shell>")
    .description("Generate static bash, zsh, or fish completion; --human prints the raw script")
    .action((shell: string) => {
      const script = generateCompletion(program, shell);
      returnResult({ shell, script }, script.trimEnd());
    });
}

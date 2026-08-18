# Auth host option collision design

## Context and decision

The production command tree defines `--host` globally for repository operations and again on
`auth login`, `auth status`, and `auth logout`. Commander 14 accepts the duplicate declaration,
but the root command consumes `--host` even when it appears after `auth login`. The login command
then evaluates its local required option as absent and exits before the action runs. Because
`executeProgram` configures error interception only on the root command, that nested validation
also writes raw text to stderr instead of the CLI's versioned JSON failure envelope.

Renaming the authentication flag would break the documented interface. Removing the global flag
would require duplicating repository-selection options across the entire command tree. The chosen
minimal fix preserves `auth login --host URL --with-token`: authentication commands keep their
local option for discoverable help, resolve the effective value from local and inherited global
options, and validate required hosts inside the action. `executeProgram` will recursively apply
Commander output and exit interception to every existing subcommand so all parser failures remain
one JSON document on stdout with no stderr contamination.

Regression tests will use the complete `buildProgram` tree rather than an auth-only test program,
because the collision exists only when both root and child declarations are present. Tests will
cover login, status, and logout forwarding the exact host without exposing token input, plus a
nested missing-option failure that asserts exit code 2, one JSON failure document, and empty
 stderr. Existing command syntax and domain-service interfaces remain unchanged. The implementation adds
no new credential path and performs no network or credential-store operation during parsing.

## Secure one-command login

Interactive login should require only `forgejo auth login --host <origin>`. When stdin is a terminal,
the runtime will use an injected hidden-token prompt whose output never contains typed characters.
When stdin is a pipe, the same command will automatically consume one bounded token, preserving the
JSON-first workflow for agents. The existing `--with-token` flag remains compatible as an explicit
piped-input mode; using it from a terminal fails before reading so the terminal cannot echo a PAT.

Command handlers depend only on an `AuthCommandRuntime.readToken` port. The production adapter
composes a secure token-input service, while tests inject deterministic readers. This keeps terminal
mechanics out of command orchestration and preserves the existing authentication service boundary.
The terminal implementation uses Node's readline handling with a muted writable stream, restores
terminal state in `finally`, maps interruption to the stable cancellation error, and validates the
same 4096-byte, one-line, non-whitespace token contract as piped input. Prompt text may be written to
stderr during an interactive session, but the final result remains exactly one JSON document on
stdout. Tests cover hidden input, non-TTY automatic input, explicit piped mode, cancellation,
bounds, and the guarantee that neither prompt output nor serialized failures contain the token.

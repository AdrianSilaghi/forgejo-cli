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
stderr. Existing command syntax and runtime interfaces remain unchanged. The implementation adds
no new credential path and performs no network or credential-store operation during parsing.

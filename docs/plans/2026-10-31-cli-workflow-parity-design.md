# Forgejo CLI workflow efficiency

Implement the six agreed improvements on the existing TypeScript/Bun architecture:
multiline body reliability, complete CI observation, the PR lifecycle, compact output,
a bounded read-only API command, and command discovery/selection conveniences.

Preserve the versioned JSON envelope, exact-origin credentials, bounded I/O, existing
command names and destructive confirmation. Add `forgejo-cli` alongside `forgejo`
to avoid the Forgejo server executable collision. Completion is static and offline.

PR selectors accept numbers, matching same-origin URLs, explicit branches or the
current branch. Branch selection searches to exhaustion within a fixed bound and
rejects ambiguity. Merge requires a numeric PR, explicit repository, confirmation
and a full expected head SHA enforced by the server. No force merge is provided.

CI observation pins the PR head, reads the latest result of each observed workflow
and status context, and rechecks the head. Missing checks remain pending. Results
explicitly do not evaluate branch-protection requirements. Polling has deadlines,
cancellation, one final stdout document and sanitized stderr progress. Exit codes
10 and 11 mean failed and pending checks; existing error codes remain unchanged.

Field selection preserves the envelope and pagination. Invalid field syntax fails
before command execution. A successful result with an unavailable field falls back
to the full result with a stderr warning, avoiding duplicate mutations on retry.
Human tables and logs escape terminal controls. Generic API requests are GET-only
and reuse authenticated transport, response bounds and redaction.

Tests are written and observed failing before implementation. Unit and command
integration tests cover failure/race/security paths; subprocess tests exercise
production composition and packaging. Live E2E tests use a newly created private
`danubedata/forgejo-cli-e2e-*` repository explicitly requested by the operator.
They create fixture branches, PRs and small test workflows, then read back results.
The dedicated repository is retained as reviewable evidence. Production repositories,
runner configuration, credentials and release workflows are outside this change.

## Validation

- TDD regressions were observed failing before the corresponding implementations.
- `bun run verify`: 479 tests, 1,523 assertions, zero failures; 98.64% line and
  97.90% function coverage. Formatting, lint, TypeScript, build and audit pass.
- Upgraded Zod from 4.4.3 to 4.6.7 after audit found GHSA-mrhx-c7xc-m3w5 in the
  existing dependency; the final audit reports no vulnerabilities.
- Live E2E on Forgejo 17.0.1: 36 CLI invocations and 15 completed assertions/groups.
  Repository: https://git.ifasconsult.ro/danubedata/forgejo-cli-e2e-20261031-workflows
  PR #1 was created, edited, closed, reopened and squash-merged after the exact-head
  guard rejected a mismatched SHA. Runs #3 and #4 respectively proved success and
  intentional failure; failed-job logs contained the expected failure marker.
- Piped multiline bodies and comments were read back from the server. Branch,
  current-branch and URL selectors, diff, compact output, generic GET pagination,
  pending state, deadlines and SIGINT cancellation passed against the live forge.
- The original credential lacked organization permissions. With explicit operator
  authorization, a temporary token with organization/repository/issue write scopes
  was held only in process memory and revoked afterward (HTTP 204 confirmed).
- Standalone binary smoke tests and the `forgejo-cli` executable collision check
  pass. Bash/Zsh completion syntax is checked; Fish generation is tested, but a
  Fish interpreter is unavailable on this machine.

The private test repository is retained as evidence. Its failed workflow is
intentional. No CLI release or application production deployment is part of this
validation.

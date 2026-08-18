# Forgejo CLI Design

Date: 2026-08-18
Status: Approved

## Objective

Build a standalone, agent-first Forgejo CLI in TypeScript on Bun for macOS and
Linux. The first release covers authentication, repository detection, pull
requests, reviews, issues, labels, milestones, and releases. It is distributed
as both an npm package and signed standalone binaries compiled with Bun.

## Architecture

Use a domain-focused Forgejo REST client rather than exposing the full API or
generating the public command surface from OpenAPI. Implement only the endpoints
required by the supported commands. Each command owns its input schema and maps
Forgejo responses into a stable CLI response contract.

Git is used only for local repository discovery: remotes, current branch,
upstream branch, and commit state. Forgejo mutations use the REST API through a
single hardened HTTP client.

The main components are:

- CLI command parser and command handlers.
- Input validation and normalized command options.
- Git repository and remote resolver.
- Host-bound account and credential resolver.
- Forgejo HTTP client and domain services.
- Versioned JSON response and error presenters.
- Platform credential-store adapters.

Implementation follows SOLID principles:

- Each command handler has one orchestration responsibility.
- Domain services expose narrow, operation-focused interfaces.
- Commands depend on service abstractions rather than HTTP, Git, files, or
  credential-store implementations.
- The hardened HTTP client implements a small `ForgejoApi` port used by domain
  services.
- Configuration, credentials, Git discovery, presentation, and transport are
  independently replaceable adapters.
- New command behavior is added through new handlers/services rather than
  conditional growth in a central dispatcher.

All data structures are treated as immutable values; transformations produce
new objects instead of mutating inputs or Forgejo response payloads.

## Command Surface

The initial command groups are:

```text
forgejo auth login|status|list|logout
forgejo repo detect|view
forgejo pr create|list|view|comment|review
forgejo issue create|list|view|edit|close|reopen|comment
forgejo label list|create|edit|delete
forgejo milestone list|create|edit|close|delete
forgejo release list|view|create|edit|delete|upload
```

Commands follow GitHub CLI-style naming where practical.

Repository resolution is deterministic:

1. Explicit `--repo owner/name`.
2. The current Git repository remote.

The exact normalized remote origin selects the account and credential. A host
mismatch fails closed. Outside a Git repository, commands require `--host` and
enough explicit repository context.

All content can be supplied non-interactively through flags, files, or stdin.
For example, `--body`, `--body-file`, and `--body-stdin` are mutually exclusive.
The CLI never opens an editor automatically.

Destructive commands require an explicit repository, a stable server-side
resource ID, `--yes`, and a target-derived confirmation value such as
`--confirm owner/name#release:123`. Name-only deletion first resolves to exactly
one immutable ID. Missing or mismatched confirmation returns a structured error
rather than prompting.

## Agent-First Output Contract

JSON is the default output. Human-readable tables are opt-in with `--human`.
Each invocation writes exactly one JSON document to stdout. Logs and diagnostics
go to stderr.

Successful responses use a versioned envelope:

```json
{
  "schema_version": "1",
  "ok": true,
  "data": {}
}
```

List command data contains a stable `{ "items": [], "pagination": {} }`
object. Keeping pagination beside the affected collection avoids a second
top-level envelope variant while preserving one response schema for every
command.

Failures use stable symbolic error codes:

```json
{
  "schema_version": "1",
  "ok": false,
  "error": {
    "code": "conflict",
    "message": "A pull request already exists for this head branch.",
    "retryable": false,
    "details": {}
  }
}
```

Exit codes distinguish invalid invocation, authentication, authorization,
missing resources, conflicts, rate limits, network failures, and server
failures. Agents do not need to parse human prose.

List commands return one page by default with pagination metadata. `--paginate`
retrieves additional pages up to an explicit `--max-items` bound.

## Authentication and Credentials

Credentials are bound to a normalized origin consisting of scheme, hostname,
and port, plus the Forgejo username. Persistent tokens live in macOS Keychain or
Linux Secret Service. Ordinary configuration stores account metadata only.

Agent login reads a personal access token from stdin:

```bash
printf '%s' "$TOKEN" | forgejo auth login \
  --host https://git.example.com \
  --with-token
```

The token is never accepted as a command argument. Login validates the token
with `GET /api/v1/user`, records the authenticated identity, and persists it only
after successful validation. The CLI never requests or stores a Forgejo account
password.

`FORGEJO_TOKEN` is the non-persistent override for CI and ephemeral agents. An
environment token always requires an explicit `--host` or `FORGEJO_HOST`; a Git
remote alone cannot choose where an environment token is sent. The explicit
origin must match the operation's resolved repository origin.

Forgejo does not reliably expose the current PAT's metadata to that same PAT.
The CLI therefore does not claim to verify scopes it cannot inspect. It
documents the required `write:repository` and `write:issue` capabilities and
returns structured authorization failures.

## Network Security

The HTTP client:

- Requires HTTPS by default.
- Allows insecure HTTP only for loopback addresses with an explicit flag.
- Never accepts arbitrary absolute API URLs.
- Processes redirects manually.
- Retains credentials only across same-origin redirects.
- Removes authentication from approved cross-origin asset downloads or fails.
- Applies connect and total request timeouts.
- Redacts authorization headers, tokens, secret fields, and request bodies from
  diagnostics.

Origin canonicalization is specified and table-tested. DNS names are converted
to ASCII, lowercased, and stripped of default ports. Explicit non-default ports
remain part of the origin. Userinfo, trailing-dot hosts, control characters,
queries, fragments, encoded path separators, and parent-path segments are
rejected. IPv6 literals must be bracketed. HTTPS, SSH URL, and scp-style Git
remotes are parsed locally without contacting a remote. SSH origins select an
already configured HTTPS origin for the same host; they never guess an API port.

Redirect handling is limited to three hops. Same-origin means an exact match of
normalized scheme, host, and effective port. HTTPS-to-HTTP downgrades fail.
Unsafe methods and request bodies are never rewritten or replayed across a
redirect.

Debug output may contain request IDs, HTTP methods, sanitized paths, timing, and
status codes. It never contains credentials or bodies. The same central
redactor applies to JSON error details, exception serialization, config output,
remote URLs, query parameters, and every stdout/stderr path.

Git discovery is strictly local and read-only. It never contacts a remote,
executes hooks, invokes credential helpers, or silently applies `insteadOf`
rewrites. Remote URLs containing credentials are rejected and redacted.

Credential-store adapters fail closed. There is no automatic plaintext
fallback. Metadata configuration is written with owner-only permissions where
the platform supports them.

## Reliability

Read-only requests may use bounded exponential backoff with jitter for network
failures, rate limits, and transient server errors. Mutating requests are not
retried automatically unless the operation is provably idempotent or its outcome
can be reconciled safely.

For an uncertain pull-request creation result, the CLI may query for an existing
pull request with the exact repository, base, and head before deciding whether a
second request is safe.

Signals cancel in-flight work cleanly. Partial operations return structured
context but never claim a rollback unless one completed.

## Testing

Development follows TDD with at least 80% statement and branch coverage.

- Unit tests cover remote parsing, origin normalization, argument validation,
  response envelopes, error mapping, pagination, retries, and redaction.
- HTTP contract tests cover every supported endpoint, malformed responses,
  permission failures, rate limits, and compatible server variations.
- Integration tests run against disposable current-stable and LTS Forgejo
  containers.
- Binary E2E tests exercise the produced macOS and Linux artifacts and compare
  their JSON behavior with the npm distribution.

Security regressions cover cross-origin requests, redirects, plaintext HTTP,
process-argument leakage, secret redaction, and credential persistence.
Credential-store tests use isolated adapters and never touch a developer's real
keychain.

Destructive-command regressions require an explicit repository, immutable
resource ID, `--yes`, and the exact target-derived confirmation value. Login
regressions enforce bounded stdin input, reject token-bearing argv forms, and
prove that failed or interrupted validation persists nothing.

JSON schemas are versioned and protected with contract tests. Additive fields
are permitted within schema version 1; breaking changes require a new schema
version.

## Distribution

The canonical TypeScript source uses Bun as its development runtime, test
runner, bundler, and standalone compiler. It produces:

- An npm package for development and compatible JavaScript environments.
- Standalone binaries for macOS and Linux, cryptographically signed through
  GitHub's Sigstore-backed build-provenance attestations.

Releases originate from signed tags through a protected, least-privilege CI
identity. Workflow dependencies are pinned by immutable digest. npm publication
uses trusted publishing/provenance rather than a long-lived publish token. CI
publishes checksums, signed provenance attestations, and an SBOM, then verifies
that the provenance subject and installed artifact digests match. Native macOS
Developer ID signing/notarization requires separately provisioned Apple
credentials and is not implied by the portable Sigstore verification path.
Install scripts are forbidden unless separately audited and approved. Each
artifact is installed into a clean environment and smoke-tested before
publication. The CLI has no automatic self-update behavior, allowing agents to
pin and verify an exact version.

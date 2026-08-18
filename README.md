# forgejo-cli

An agent-first Forgejo CLI built with TypeScript and Bun. JSON is the default,
all repository selection is deterministic, and persistent tokens stay in the
operating-system credential store.

The initial `0.1` command surface covers authentication, repository detection,
pull requests and reviews, issues, labels, milestones, releases, and streamed
release assets.

## Security model

- Personal access tokens are accepted only through stdin.
- `FORGEJO_TOKEN` requires an exact `FORGEJO_HOST` or `--host` binding.
- Persistent tokens use macOS Keychain or Linux Secret Service through Git's
  platform credential helpers. There is no plaintext fallback.
- HTTPS is required. Git discovery is local and read-only.
- Authenticated redirects must remain on the exact scheme, host, and port.
- Destructive operations require an explicit repository, an immutable numeric
  ID, `--yes`, and an exact target-derived `--confirm` value.
- Release assets are streamed from bounded regular files. Symlinks are rejected.

Create a least-privilege Forgejo personal access token with the repository and
issue permissions needed by the commands you use. The CLI never asks for your
Forgejo password and never creates an all-scope token.

## Install

During development:

```bash
bun install --frozen-lockfile
bun run build
bun link
```

Build a standalone binary that does not require Bun at runtime:

```bash
bun run build:binary
./artifacts/forgejo --version
```

Standalone builds disable Bun's automatic `.env` and `bunfig.toml` loading.
Release artifacts are intended to be downloaded from GitHub Releases and
verified against their checksums and GitHub build-provenance attestations.

```bash
gh attestation verify ./forgejo-linux-x64 \
  --repo AdrianSilaghi/forgejo-cli
```

## Authenticate

Login interactively with a hidden token prompt:

```bash
forgejo auth login --host https://git.example.com
```

Agents and scripts can pipe the token through stdin:

```bash
printf '%s' "$FORGEJO_PAT" | forgejo auth login \
  --host https://git.example.com \
  --with-token
```

Use a non-persistent CI token:

```bash
export FORGEJO_HOST=https://git.example.com
export FORGEJO_TOKEN='...'
forgejo --repo owner/project repo view
```

The host binding is mandatory. A Git remote alone can never choose where an
environment token is sent.

## Agent-oriented behavior

Every normal invocation emits exactly one versioned JSON document on stdout:

```json
{
  "schema_version": "1",
  "ok": true,
  "data": {
    "id": 42
  }
}
```

Failures have stable symbolic codes and process exit codes:

```json
{
  "schema_version": "1",
  "ok": false,
  "error": {
    "code": "not_authenticated",
    "message": "No usable credential exists for this account.",
    "retryable": false,
    "details": {}
  }
}
```

The machine-readable contract is in
[`schemas/response-v1.schema.json`](schemas/response-v1.schema.json). Add
`--human` for an opt-in human rendering. The default remains JSON, including
help, version, parser failures, and API failures.

Exit codes:

| Code | Meaning |
| ---: | --- |
| `0` | Success |
| `2` | Invalid input or missing destructive confirmation |
| `3` | Missing/unavailable authentication |
| `4` | Forgejo denied access |
| `5` | Resource not found |
| `6` | Conflict |
| `7` | Rate limited |
| `8` | Network failure or timeout |
| `9` | Server, protocol, or configuration failure |
| `130` | Cancelled |

## Repository selection

Selection precedence is:

1. `--repo owner/repository`
2. the named local Git remote (`--remote`, default `origin`)

Use `--host` for an explicit HTTPS origin and `--account` when an origin has
multiple configured users. HTTPS Git remotes retain their exact non-default
port. SSH remotes must map to exactly one configured HTTPS origin; ambiguity
fails closed. When `--host` or `FORGEJO_HOST` is combined with a Git-derived
repository, the remote must resolve to that exact origin. Use an explicit
`--repo` when intentionally targeting a different repository host.

Examples:

```bash
forgejo repo detect
forgejo --host https://git.example.com --repo owner/project repo view
```

## Pull requests

```bash
forgejo pr create \
  --title "Add agent-safe output" \
  --head feature/agent-output \
  --base main \
  --body-file ./pr-body.md

forgejo pr list --state open --limit 30
forgejo pr view 42
printf '%s' 'Looks good.' | forgejo pr comment 42 --body-stdin
forgejo pr review 42 --approve --body 'Validated locally.'
```

If `--head` is omitted, `pr create` uses the current local branch. If `--base`
is omitted, it reads the repository's default branch from Forgejo.

## Issues, labels, and milestones

```bash
forgejo issue create --title 'Bug' --body-file ./issue.md --labels 2,8
forgejo issue list --state open --paginate --max-items 200
forgejo issue close 17

forgejo label create --name bug --color d73a4a
forgejo label edit 2 --description 'Something is not working'

forgejo milestone create --title v1.0 --due-on 2026-09-01T00:00:00Z
forgejo milestone close 9
```

List commands return `{items, pagination}`. They fetch one page by default.
`--paginate` requires `--max-items`; page size is capped at 100 and a single
operation is capped at 10,000 items.

## Releases

```bash
forgejo release create --tag v0.1.0 --target main --body-file ./CHANGELOG.md
forgejo release view v0.1.0 --tag
forgejo release upload 42 ./artifacts/forgejo-linux-x64 \
  --name forgejo-linux-x64
```

Release upload sends a fixed same-origin multipart request and does not replay
the mutation across redirects.

## Destructive operations

Deletion never relies on auto-detected repository context. For label ID `7`:

```bash
forgejo --repo owner/project label delete 7 \
  --yes \
  --confirm 'owner/project#label:7'
```

Milestone and release deletion use `milestone:<id>` and `release:<id>` in the
same confirmation format.

## Development

```bash
bun install --frozen-lockfile
bun test
bun run coverage
bun run format
bun run lint
bun run typecheck
bun run verify
```

The project follows TDD, strict TypeScript, immutable domain values, runtime
validation of Forgejo responses, SOLID service boundaries, and an 80% minimum
coverage gate.

GitHub release builds fail closed until the repository variable
`RELEASE_SIGNING_PUBLIC_KEY` contains the trusted armored GPG public key used
to sign annotated `v*` tags. The workflow verifies that signature and requires
the tagged commit to be reachable from `main` before producing artifacts. npm
publication uses OIDC trusted publishing with provenance and no long-lived npm
token; that publisher relationship must be configured on npm before the first
release.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and
[`docs/plans/2026-08-18-forgejo-cli-design.md`](docs/plans/2026-08-18-forgejo-cli-design.md)
for the approved architecture.

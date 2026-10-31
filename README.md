# @danubedata/forgejo-cli

An agent-first Forgejo CLI originally built for DanubeData's agentic
engineering workflow. It is a general-purpose, free and open-source tool built
with TypeScript and Bun. JSON is the default, repository selection is
deterministic, and persistent tokens stay in the operating-system credential
store.

The command surface covers authentication, repository detection, pull request
lifecycle and CI checks, issues, labels, milestones, releases, Actions runs and
logs, bounded read-only API requests, and shell completion.

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

Install the public npm package globally. The npm distribution requires Bun
1.3.6 or newer at runtime. Both executable names invoke the same CLI:

```bash
npm install --global @danubedata/forgejo-cli
forgejo-cli --version
```

Use `forgejo-cli` when `forgejo` on your PATH already names the Forgejo server
binary. The examples below use `forgejo`; either installed name works.

Alternatively, build or download a standalone binary that does not require Bun
at runtime:

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
`--human` for tables of list results and jobs, readable object fields, or raw
logs, diffs, and completion scripts. The default remains JSON, including help,
version, parser failures, and API failures. Untrusted terminal controls are escaped.

Use `--fields number,title,state` to select unique, flat fields from object data
or each collection item; the response envelope and pagination remain intact.
Nested paths and duplicate or invalid names fail before the command acts. If a
requested field is unavailable in the completed response, the CLI warns on
stderr and returns the full output with its original exit status, so a completed
mutation is not reported as a failure.

```bash
forgejo --fields number,title,state pr list
forgejo --human run jobs 1499
```

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
| `10` | Observed CI checks failed, or a watched run failed with `--exit-status` |
| `11` | Observed PR checks are pending or absent |
| `130` | Cancelled |

Checks can return `ok: true` with exit `10` or `11`: the request succeeded and
`data` contains the check outcome. Inspect both the document and process status.
Transient GET/HEAD failures receive at most two retries within the request
timeout, respecting `Retry-After`; mutations are not retried. SIGINT and SIGTERM
cancel requests, retry waits, and watches.

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
forgejo pr edit 42 --title 'Add agent-safe output' --body-file ./pr-body.md
forgejo --human pr diff 42
forgejo pr close 42
forgejo pr reopen 42
printf '%s\n' 'Validated locally.' '' 'Tests pass.' | forgejo pr comment 42 --body-stdin
forgejo pr review 42 --approve --body 'Validated locally.'
```

If `--head` is omitted, `pr create` uses the current local branch. If `--base`
is omitted, it reads the repository's default branch from Forgejo.

`view`, `edit`, `diff`, `close`, `reopen`, `comment`, `review`, and `checks` accept
a PR number, a branch name (including `owner:branch` for a fork), or a URL
matching the selected Forgejo origin and repository. Omit the selector to find
the PR for the current local branch. Branch lookup requires a unique open PR
(`reopen` searches closed PRs); use a number or matching URL for ambiguous
branches or detached checkouts. URLs do not switch the selected host or repository.

Body-bearing PR, issue, and release commands share `--body`, `--body-file`, and
`--body-stdin`; select one source. `--body-file -` also reads stdin. Multiline
text, tabs, Unicode, and trailing newlines are preserved, with a 1 MiB input
bound. Empty comments and prohibited control characters are rejected.

Merge requires an explicit repository and numeric PR, exact confirmation, and
the expected full head SHA:

```bash
forgejo -R owner/project pr merge 42 --squash \
  --head-sha 0123456789abcdef0123456789abcdef01234567 \
  --yes --confirm 'owner/project#pr:42'
```

Choose `--merge`, `--squash`, `--rebase`, or `--method` once. The default is
`merge`; `--method` also supports `rebase-merge` and `fast-forward-only`. A changed
head fails closed, and there is no force option to bypass server merge policy.

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
forgejo release create --tag v0.0.1 --target main --body-file ./CHANGELOG.md
forgejo release view v0.0.1 --tag
forgejo release upload 42 ./artifacts/forgejo-linux-x64 \
  --name forgejo-linux-x64
```

Release upload sends a fixed same-origin multipart request and does not replay
the mutation across redirects.

## Actions

Runs are addressed by the number in their web URL (`…/actions/runs/1499`), and
jobs by their 0-based index in that run (`…/runs/1499/jobs/0`). Listing and
viewing runs and `workflow dispatch` work on Forgejo 15; everything else needs
the Actions API that Forgejo 16 added.

```bash
forgejo run list --status failure --branch main --limit 5
forgejo run view 1499
forgejo run jobs 1499
forgejo run watch 1499 --exit-status --interval 3 --timeout 300
forgejo run logs 1499 --job 0 --tail-bytes 20000   # the end of the log, where failures are
forgejo --human run logs 1499                       # the raw log instead of JSON
forgejo run logs 1499 --failed --tail-bytes 20000
forgejo run download-logs 1499 --output ./run-1499-logs.zip
forgejo run cancel 1499
forgejo workflow dispatch build.yml --ref main --input environment=staging
forgejo artifact list --run 1499
forgejo artifact download 77 --output ./coverage.zip
```

`run logs --failed` collects only failed jobs, with a 64 KiB tail per job by
default and a 1 MiB maximum. Use `--tail-bytes` to change the tail size within that bound;
`--failed` cannot be combined with `--job`.

Inspect CI for the exact PR head:

```bash
forgejo pr checks 42
forgejo pr checks --watch --workflow build.yml --interval 3 --timeout 300
```

Check states are `success`, `failure`, and `pending`, with exits `0`, `10`, and
`11`. Missing checks, waiting runs, and unknown states remain pending. Checks
match the exact head SHA and latest observed workflow runs; a changed PR head
aborts the watch. `--workflow` restricts the observed workflows and omits commit
status contexts. These results do not certify branch-protection or required-check
readiness (`required_checks_evaluated` is always false).

Both watches accept `--interval` (default 3 seconds, maximum 3600) and `--timeout`
(default 300 seconds, maximum 86400). They emit one final JSON document; timeout
is exit `8`, cancellation is `130`. `run watch` returns `0` when observation
completes unless `--exit-status` is set, which returns `10` for an unsuccessful
terminal run.

`workflow dispatch` returns the run it started, so its `number` feeds straight
into `run logs`. A job that no runner has picked up yet reports
`started: false` with an empty log rather than an error. Log text is redacted
like every other output. Downloads never overwrite an existing file or follow a
symlink, and are capped at 2 GiB.

## Read-only API and completion

```bash
forgejo -R owner/project api repos/owner/project/pulls --query state=open
forgejo -R owner/project api repos/owner/project/issues \
  --query state=open --paginate --max-items 200 --limit 50
forgejo --human completion bash > ./forgejo-completion.bash
forgejo --human completion zsh > ./_forgejo
forgejo --human completion fish > ./forgejo.fish
```

`api` accepts API-relative paths, including `/api/v1/...`, and repeated
`--query key=value` parameters. It only issues GET requests to the authenticated
origin; absolute URLs, unsafe path segments, and method overrides are rejected.
Responses are bounded and redacted. Pagination requires an array response and
an explicit `--max-items` limit; use `--page` and `--limit` for paging rather
than conflicting query parameters.

Completion scripts are static, generated from the command tree without
credentials or network requests. Default output wraps the script in JSON;
`--human` emits the raw script for shell installation.

## Destructive operations

Deletion never relies on auto-detected repository context. For label ID `7`:

```bash
forgejo --repo owner/project label delete 7 \
  --yes \
  --confirm 'owner/project#label:7'
```

Milestone and release deletion use `milestone:<id>` and `release:<id>` in the
same confirmation format; run and artifact deletion use `run:<number>` and
`artifact:<id>`.

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

### Opt-in live E2E

The live suite creates and retains a dedicated private repository for inspection.
Use a unique disposable name and confirm that exact repository:

```bash
bun run e2e:live --host https://git.ifasconsult.ro \
  --repo danubedata/forgejo-cli-e2e-20261031-unique \
  --confirm danubedata/forgejo-cli-e2e-20261031-unique
```

Authenticate first or use a host-bound environment token. Workflow jobs use the
`ubuntu-latest` runner label by default; add `--runner danubedata-light` when
that is the available test runner. This command writes only within its dedicated
test repository and leaves it available for review; it is separate from the
local verification suite.

### Initial npm publication

`@danubedata/forgejo-cli@0.0.1` is the one-time bootstrap release. npm requires
the package to exist before its trusted GitHub publisher can be configured, so
a DanubeData npm maintainer protected by two-factor authentication must run the
manual bootstrap workflow from `main`. The workflow requires the exact package
confirmation plus approval through the protected `npm-bootstrap` environment,
and exposes the existing `NPM_TOKEN` secret only to its final publish step.
`NPM_TOKEN` must be a granular npm access token authorized to create and
publish public packages in the `@danubedata` scope, with bypass 2FA enabled for
non-interactive automation:

```bash
gh workflow run bootstrap-npm.yml \
  --repo AdrianSilaghi/forgejo-cli \
  --ref main \
  -f confirmation='@danubedata/forgejo-cli@0.0.1'
```

After that initial publication, configure npm trusted publishing for package
`@danubedata/forgejo-cli` with:

- GitHub repository `AdrianSilaghi/forgejo-cli`;
- workflow filename `release.yml`;
- allowed action `npm publish`.

After trusted publishing is configured, require two-factor authentication,
disallow token-based publishing in the npm package settings, and delete the
`NPM_TOKEN` GitHub secret. The signed `v0.0.1` release verifies that the npm
artifact created by bootstrap has the exact same integrity before it skips the
already-completed publication. Future versions publish through OIDC from signed
annotated `v*` tags whose version exactly matches both `package.json` and the
CLI's reported version.

GitHub release builds fail closed until the repository variable
`RELEASE_SIGNING_PUBLIC_KEY` contains the trusted armored GPG public key used
to sign annotated `v*` tags. The workflow verifies that signature and requires
the tagged commit to be reachable from `main` before producing artifacts. npm
ongoing publication uses OIDC trusted publishing with provenance and no
long-lived npm token; that publisher relationship is configured immediately
after the one-time bootstrap.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and
[`docs/plans/2026-08-18-forgejo-cli-design.md`](docs/plans/2026-08-18-forgejo-cli-design.md)
for the approved architecture.

# Forgejo Actions Commands Design

Date: 2026-09-22
Status: Approved

## Objective

Expose the Actions REST API that Forgejo 16 added, so agents can follow CI
without a browser session: list a run's jobs, read a job's log (whole or its
tail), download a run's logs, cancel or delete a run, and list, download, or
delete artifacts. Also expose the two older endpoints those depend on — listing
and viewing runs (Forgejo 15+) — and `workflow_dispatch` (15+), which starts the
runs the rest of the surface follows.

`GET /actions/run` is deliberately left out: it answers only for an Actions
runtime token inside a job, never for a user token.

## Command Surface

```text
forgejo run list [--status s,…] [--event e,…] [--workflow file] [--branch name | --ref ref] [--sha sha]
forgejo run view <number>
forgejo run jobs <number>                                   (Forgejo 16+)
forgejo run logs <number> [--job index] [--attempt n] [--tail-bytes n]   (16+)
forgejo run download-logs <number> --output path            (16+)
forgejo run cancel <number>                                 (16+)
forgejo run delete <number>                                 (16+, destructive)
forgejo workflow dispatch <file> --ref ref [--input key=value …]
forgejo artifact list [--run number] [--name name]          (16+)
forgejo artifact view <id>                                  (16+)
forgejo artifact download <id> --output path                (16+)
forgejo artifact delete <id>                                (16+, destructive)
```

Runs are addressed by **run number**, the number in the web UI and in
`…/actions/runs/<number>` URLs, and resolved to the API `id` with the
`run_number` list filter. Output always carries both. Jobs are addressed by
their 0-based position in the run, matching `…/runs/<number>/jobs/<index>`.
Artifacts have no number, so they use their API `id`.

`run logs` returns the log text inside the normal JSON document; `--human`
prints the raw text. Log text passes through the existing redaction, which
removes authorization values and URL credentials that a job may have printed.

## Transport

Two narrow capabilities join `ForgejoApi`, following `ForgejoAssetUploader`:

- `ForgejoTextReader.readText` returns a `text/plain` body with the HTTP 206
  flag and the total size from `Content-Range`. `tailBytes` sends
  `Range: bytes=-N`, which is how an agent reads the end of a 3,000-line build
  log in one bounded request.
- `ForgejoDownloader.download` returns the response body as a stream for zip
  archives, under a separate, longer timeout. Commands write it with
  `DownloadFileTarget`, which refuses to overwrite a file or follow a symlink,
  enforces a byte limit, and removes a partial file on failure.

Both reuse the existing redirect policy: same-origin only, no user information,
bounded hops. Query values may now be string arrays, sent as repeated keys,
which is how Forgejo reads `status` and `event` filters.

## Forgejo Behavior the Implementation Relies On

Measured against Forgejo 16.0.5:

- `GET /actions/runs` ignores `limit` unless `page` is also sent, and then
  returns every run: 1,504 runs and 32 MB for one repository, twice the default
  response cap. Every list request therefore sends `page`.
- Each run embeds its full event payload (about 11 KB of 15 KB), so the
  normalized run keeps only stable fields.
- `ref` filters need a full ref: `refs/heads/master` matches, `master` does not.
  `--branch` builds the ref; `--ref` passes one through.
- `started` and `stopped` are `1970-01-01T00:00:00Z` until a run starts, and
  `duration` is nanoseconds or `null`; both normalize to `null`.
- `event` can be empty on dispatched runs, while `trigger_event` is always set.
- A job that has not started answers its log endpoint with 404. `run logs`
  reports `started: false` with an empty log instead of failing.
- Cancelling a finished run succeeds as a no-op (HTTP 204).
- The job log endpoint accepts `attempt`; the `step` parameter mentioned in the
  16.0 release notes is ignored by the server, so it is not offered.

On Forgejo 15 the 16+ endpoints answer 404. The help text and README name the
minimum version rather than probing it.

## Safety

- `run delete` and `artifact delete` follow the existing destructive contract:
  explicit `--repo`, `--yes`, and `--confirm owner/repository#run:<number>` or
  `#artifact:<id>`.
- `run cancel` is not treated as destructive: it deletes nothing and a
  cancelled run can be rerun.
- Downloads never overwrite, never follow a symlink at the output path, and are
  bounded in size.

## Testing

Services are tested against a stub `ForgejoApi`, `ForgejoTextReader` and
`ForgejoDownloader`; the HTTP client against a fake `fetch`; commands through
`executeProgram`; the file target against a temporary directory. Regression
tests cover every behavior in the list above.

# DanubeData npm release design

Date: 2026-08-18
Status: approved

## Context

`forgejo-cli` was originally built for DanubeData's agentic engineering
workflow on Forgejo. It is intentionally general enough for other Forgejo
users and is published as free, open-source software.

The repository already builds a JSON-first CLI, native executables, SBOMs,
checksums, and build-provenance attestations. It also contains tag-driven npm
publishing, but the public package identity and current npm trusted-publishing
runtime requirements need to be made explicit and verified.

## Decisions

- Publish the package as `@danubedata/forgejo-cli`.
- Keep the executable name `forgejo`.
- Publish the scoped package publicly under the MIT license.
- Attribute the work to Adrian Silaghi and DanubeData contributors.
- Describe DanubeData as the workflow this project was originally built for,
  without restricting the CLI to DanubeData or implying Forgejo endorsement.
- Use signed `v*` tags as the only automated release trigger.
- Use npm trusted publishing through GitHub Actions OIDC for ongoing releases.
- Do not store a long-lived npm publishing token in GitHub.
- Retain native binaries, checksums, SPDX SBOMs, GitHub attestations, and npm
  provenance as release outputs.

## Package contract

`package.json` will declare:

- package name `@danubedata/forgejo-cli`;
- public npm access and the public npm registry;
- MIT licensing and DanubeData-oriented keywords;
- the exact public GitHub repository used by npm provenance;
- the existing `forgejo` binary entry point;
- only the built CLI, response schema, README, security policy, and license in
  the published tarball.

Changing the package name must not change the installed command. Both
`npm install --global @danubedata/forgejo-cli` and package-tarball smoke tests
must resolve the executable as `forgejo`.

## Release flow

1. A maintainer updates `package.json` to the intended semantic version.
2. A trusted maintainer creates and pushes a signed annotated `v<version>` tag.
3. GitHub Actions verifies the tag signature and confirms the tagged commit is
   reachable from `main`.
4. The workflow installs locked dependencies and runs all verification gates.
5. Matrix jobs build macOS and Linux binaries, then generate SPDX SBOMs and
   GitHub provenance attestations.
6. A draft GitHub Release is staged with binaries, SBOMs, and checksums.
7. The npm job verifies tag/package version equality, packs the exact tarball,
   installs it in an isolated directory, and smoke-tests its `forgejo` binary.
8. npm trusted publishing exchanges the GitHub OIDC identity for a short-lived
   publishing credential and publishes the public package with provenance.
9. Only after npm succeeds is the draft GitHub Release made public.

Release jobs use GitHub-hosted runners, Node 24, a current npm CLI compatible
with trusted publishing, no package-manager cache, and least-privilege job
permissions.

## Initial publication

npm requires a package to exist before its trusted-publisher relationship can
be configured. Version `0.0.1` therefore has a one-time bootstrap procedure:

1. A maintainer manually dispatches `bootstrap-npm.yml` from the current
   `main`, entering the exact package/version confirmation.
2. The protected `npm-bootstrap` environment requires maintainer approval. The
   workflow then runs the complete verification and tarball smoke tests, fails
   closed unless npm returns `E404` for the exact version, and publishes with
   the existing `NPM_TOKEN` exposed only to the final step. The secret must be
   a granular token authorized for public publishing in the `@danubedata`
   scope, with bypass 2FA enabled for automation.
3. A maintainer configures the package's trusted GitHub publisher for:
   - repository: `AdrianSilaghi/forgejo-cli`;
   - workflow: `release.yml`;
   - permission: `npm publish`.
4. Require 2FA, disallow token-based publishing, and delete the `NPM_TOKEN`
   GitHub secret after trusted publishing is configured.
5. Push the signed `v0.0.1` tag. The release workflow accepts the bootstrap
   package only when the registry `dist.integrity` exactly matches the freshly
   packed artifact, then publishes the GitHub Release.
6. Use the automated signed-tag workflow with short-lived OIDC credentials for
   all subsequent versions.

## Failure behavior

- Missing signing-key configuration fails before any artifact is published.
- An invalid or unsigned tag fails before building release artifacts.
- A tag that is not reachable from `main` fails closed.
- A tag/package version mismatch blocks npm publication.
- A package tarball whose installed CLI fails the JSON contract blocks npm
  publication.
- An existing npm version whose registry integrity differs from the local
  release artifact blocks the GitHub Release.
- Any npm failure leaves the GitHub Release as a draft rather than presenting a
  partially published release as complete.

## Verification

Contract tests will validate the scoped package identity, public access,
license, repository provenance metadata, stable executable name, publishable
file allowlist, Node/npm release runtime, OIDC permission, signed-tag checks,
version equality guard, tarball smoke test, and publish-after-staging order.

The full release-readiness gate remains formatting, linting, strict TypeScript,
unit/integration/E2E tests with at least 80% coverage, build, dependency audit,
native-binary smoke test, and npm-tarball inspection.

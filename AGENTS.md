# Forgejo CLI Engineering Guide

## Runtime and tooling

- Use TypeScript with Bun for development, tests, bundling, and compiled binaries.
- Use strict TypeScript and validate every external response at runtime.
- JSON is the default CLI output; stdout must contain exactly one response document.

## Design principles

- Follow SOLID principles with narrow interfaces and dependency injection.
- Command handlers orchestrate; domain services own Forgejo operations.
- Domain services depend on the `ForgejoApi` interface, never directly on `fetch`.
- Keep transport, Git discovery, credentials, config, and presentation replaceable.
- Prefer immutable values and return new objects rather than mutating inputs.
- Avoid abstractions that do not establish a real security or testing boundary.

## Security

- Never accept tokens through argv or store tokens in plaintext.
- Bind credentials to the exact normalized Forgejo origin and username.
- Never send an environment token to a host inferred only from an untrusted Git remote.
- Fail closed on cross-origin redirects, insecure hosts, ambiguous remotes, and missing keychains.
- Redact secrets from every stdout, stderr, error, debug, and serialization path.
- Destructive operations require explicit repository, immutable resource ID, `--yes`, and a target-derived `--confirm` value.

## Testing and verification

- Follow TDD: commit a failing behavioral test before the minimal implementation when practical.
- Maintain at least 80% line, function, and statement coverage.
- Add regression tests for every security finding and bug fix.
- Before commits, run formatting, linting, type checking, tests with coverage, build, dependency audit, and diff review.

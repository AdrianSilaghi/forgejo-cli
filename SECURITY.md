# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through the repository's
GitHub Security Advisory interface. Do not open a public issue containing a
token, credential, private Forgejo URL, sensitive response body, or exploit.

Include the affected version, platform, reproduction steps, security impact,
and whether a credential may have been exposed. Revoke and rotate any token
that may have crossed an unintended trust boundary before sending the report.

## Supported versions

Until the first stable release, only the latest published `0.x` release is
supported with security fixes. Pin an exact release and verify its checksum and
GitHub provenance attestation.

## Security invariants

- Tokens are never accepted in command-line arguments.
- Persistent tokens are never written to the metadata configuration file.
- Credentials are bound to an exact normalized HTTPS origin and username.
- Environment tokens require an explicit matching host binding.
- Authenticated requests cannot target caller-supplied absolute URLs.
- Cross-origin redirects fail closed.
- Mutations are not replayed after redirects.
- Destructive repository operations require explicit, target-derived
  confirmation.
- Release assets are opened without following symlinks and streamed from the
  validated file handle.
- Release publication requires a tag signed by the configured trusted GPG key.
- Secret-bearing failure data is redacted before serialization.

The detailed threat model and rationale live in the approved design document
under `docs/plans/`.

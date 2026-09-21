# Security policy

TotalFinance computes from the data you pass in. It opens no network connection, reads no credential, and
holds no provider key; the local HTTP and MCP servers bind to loopback unless you say otherwise, and
every operation is read-only by construction (the registry refuses any operation that declares a side
effect). A vulnerability is therefore almost always one of: a refusal that does not happen (an input a
door should reject but does not), a resource bound that can be exceeded (input bytes, result bytes,
JSON depth, a job that does not stop when cancelled), or a path a file-backed store follows that it
should not. Those are exactly the reports we want.

## Supported versions

| Version                                   | Supported                                               |
| ----------------------------------------- | ------------------------------------------------------- |
| the latest `0.1.0-preview.N` on `preview` | yes — fixes ship as the next preview of the whole group |
| any earlier preview                       | no — upgrade; the group moves together                  |

## Reporting a vulnerability

Report privately through GitHub's **Security → Report a vulnerability** on the TotalFinance repository
(`https://github.com/InsiderFinance/totalfinance/security/advisories/new`). Please do not open a public
issue for anything you believe is exploitable. Include the package and version, the smallest input
that reproduces the behaviour, and what you expected the door to do instead; a failing test is the
best report.

## What to expect

- **Acknowledgement within 3 business days** of the report.
- **Assessment within 10 business days**: confirmed, not a vulnerability (with the reasoning), or
  a request for more detail.
- **A fix or a documented mitigation within 30 days** of confirmation for anything rated high or
  critical, shipped as a new preview of the whole fixed group with a changeset entry that credits
  the reporter (unless they prefer otherwise), plus a GitHub security advisory.
- **Coordinated disclosure**: we ask for 90 days from the report before public disclosure, or the
  release date of the fix, whichever comes first.

## Scope notes

- The published packages carry `provenance` attestations; verify a tarball against
  `RELEASE_HASHES.json` on the release before trusting it.
- The `totalfinance` CLI's default store lives under `~/.totalfinance/store`; a report that a store can be
  made to read or write outside its directory is in scope.
- Findings in the private InsiderFinance application that hosts this monorepo are out of scope
  here; report those to InsiderFinance directly.

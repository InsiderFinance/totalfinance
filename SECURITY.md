# Security policy

TotalFinance computes from the data you pass in. Compute entry points open no network connection and
hold no provider key. The optional HTTP server binds to loopback by default; MCP uses stdio.
Transports are read-only by default. Paper-execution and other write operations require explicit
capabilities, stores and authorization; no live brokerage integration is supplied.
A vulnerability may include a refusal that does not happen (an input a
door should reject but does not), a resource bound that can be exceeded (input bytes, result bytes,
JSON depth, a job that does not stop when cancelled), or a path a file-backed store follows that it
should not. Those are exactly the reports we want.

## Supported versions

| Version                                  | Supported                                                            |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `0.1.0`, once published                  | yes — fixes ship in a coordinated release of the two public packages |
| earlier development or preview artifacts | no — use the current supported release                               |

This policy covers `@insiderfinance/totalfinance` and `@insiderfinance/totalfinance-mcp`.
Version 0.1.0 remains pre-1.0 software, with preview workflow and transport components.
The version in a source checkout does not establish that a public npm release exists.

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
  critical, shipped as a new release of the public pair with a changeset entry that credits
  the reporter (unless they prefer otherwise), plus a GitHub security advisory.
- **Coordinated disclosure**: we ask for 90 days from the report before public disclosure, or the
  release date of the fix, whichever comes first.

## Scope notes

- Authorized releases must carry `provenance` attestations; verify a tarball against
  `RELEASE_HASHES.json` on the release before trusting it.
- The `totalfinance` CLI's default store lives under `~/.totalfinance/store`; a report that a store can be
  made to read or write outside its directory is in scope.
- Findings in the private InsiderFinance application that hosts this monorepo are out of scope
  here; report those to InsiderFinance directly.

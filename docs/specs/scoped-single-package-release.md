# Scoped single-package release — 0.1.0

Status: implementation in progress. This supersedes older package-count, unscoped install,
and preview-version instructions for the first npm release. Financial API contracts and release
approval gates remain in force. No npm publication or site deployment is authorized by this spec.

## Decisions

- Publish exactly `@insiderfinance/totalfinance@0.1.0` and
  `@insiderfinance/totalfinance-mcp@0.1.0`. MCP is optional. The main artifact has no runtime
  dependencies; MCP depends on the exact main version and the MCP SDK.
- Keep `packages/*` as private build/source workspaces. Their existing internal aliases and
  inventories remain implementation details, not extra npm products. Public distribution
  workspaces live in `distribution/totalfinance` and `distribution/mcp`.
- The main distribution includes the existing umbrella root, every domain/feature/expert
  export, workflows, and explicit CLI/HTTP entry points. `@totalfinance/options/black-scholes`
  becomes `@insiderfinance/totalfinance/options/black-scholes`; the umbrella root becomes
  `@insiderfinance/totalfinance`; MCP becomes `@insiderfinance/totalfinance-mcp`.
  Per-domain package.json paths are not public API. The main package exposes its own package.json.
- Preserve ESM module boundaries, one identity per shared module, declarations, source maps,
  original sources, and worker-relative URLs. Main files retain the internal layout
  `modules/<domain>/dist` and `modules/<domain>/src`; MCP retains `dist` and `src`.
  Rewrite import/export/dynamic-import/type-import specifiers in published JS and declarations
  to exact relative module files, resolving through the source export maps, not guessed filenames.
  MCP imports the public main package. No private runtime dependency or unresolved private
  declaration import may escape. All source workspaces are non-publishable.
- Browser root/domain imports must not load CLI, HTTP, Node-only workflow entry points, MCP,
  filesystem APIs, or the MCP SDK. Node floor stays 22.13.0 for consumers; publishing uses a
  trusted-publishing-compatible Node/npm toolchain.
- Public examples/reference/install instructions use the new public paths. Source-level
  manifest IDs can keep private workspace identities to preserve enforcement evidence.
- Release tooling only packs these two artifacts, verifies their metadata and hashes, and
  publishes in dependency order. External approval and npm ownership are separate gates.
  Publication is not atomic; document partial-publish recovery. Never publish from a dirty tree
  or silently enable the release workflow. The maintainer chooses when to pull the trigger.
- Release 0.1.0 is pre-1.0 software, not a 1.0 stability guarantee. Remove obsolete Changesets
  preview mode and the twenty-five-package release group. Future changesets target the two
  public artifacts. Generated runtime version metadata must agree with the release version.
- WASM is future optional work, not part of 0.1.0. Prefer explicit once-per-runtime activation
  followed by unchanged ordinary function calls; no mandatory client object, no implicit global
  activation at import, and no scalar API becoming asynchronous. Browser/worker support,
  fallback, observability, precision, and measured crossover gates remain required.

## Acceptance / execution checklist

- [x] Assemble the two public artifacts with explicit exports, metadata, licenses and types.
- [x] Make source workspaces private; preserve source inventories and validation contracts.
- [x] Verify installed granular/root imports, browser isolation, tree shaking, errors, workers,
      CLI, HTTP, MCP, and no private first-party dependency leakage.
- [x] Update release automation, versioning, smoke tests and rollback instructions for two artifacts.
- [x] Update public docs/site/reference/generators and controlling implementation instructions.
- [ ] Run formatting, lint, type checks, API reports, coverage, site tests, bundle budgets,
      fresh deterministic regeneration, and installed-artifact release rehearsal.
- [ ] Record exact completed evidence and external release gates; leave publication disabled.

## Handoff

The final evidence note must identify the release commit and commands/results, tarball names,
sizes/hashes, whether npm credentials/ownership and GitHub environment approval were verified,
and the exact maintainer trigger. Do not present local tarball verification as proof of a public
npm release or a hosted site acceptance. Website deployment is a separate explicit approval.

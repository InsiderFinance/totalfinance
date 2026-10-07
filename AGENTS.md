# TotalFinance contributor instructions

This is the standalone TypeScript finance library, not the parent web application.

- Use the runtime in `.nvmrc` and `pnpm` at the version in `package.json`. Install with
  `pnpm install --frozen-lockfile`; do not use yarn or rewrite the dependency graph incidentally.
- `docs/implementation-order.md` owns the active work queue. Read the controlling specification
  in full before implementing it. Keep acceptance checklists truthful and backed by tests.
- Preserve the library's explicit units, object-shaped financial inputs, descriptive names,
  typed errors, boundary validation, deterministic calculations, assumptions and diagnostics.
  Never introduce silent financial defaults or duplicate computation in a transport.
- Keep ESM imports and the established package dependency boundaries. Tests belong with the
  relevant package; include first-touch, generated-contract and packed-consumer coverage when
  changing a public surface. See `CONTRIBUTING.md` and `docs/library-alignment-spec.md`.
- Derived artifacts come from their generators. Use the documented regeneration order; hosted CI
  runs `pnpm regen:check` on a clean tree. Do not weaken gates or hand-edit evidence to make it pass.
- Format only changed files with the pinned local Prettier. Never run a repository-wide format
  write.
- Verify fast while iterating. Run the tests for what you changed
  (`pnpm exec vitest run <test files>`), plus `pnpm exec vitest run tools/bundle-size/budgets.test.ts`
  when bundle size can move. Regenerate affected derived artifacts once the source is final,
  including after integration changes; do not repeat the whole chain for unchanged source.
- Follow `CONTRIBUTING.md`'s fast-PR/full-gate policy: all current-head PR jobs must be green,
  with a full hosted run before landing changes to CI/enforcement gates or supported Node
  versions. Ordinary PRs do not require local full CI, a second coverage pass, or `regen:check`;
  hosted CI owns those gates. `pnpm run ci` remains available for full local verification and
  reproducing failures. Releases still require the independent repeat in the contributing guide.
  A fast PR pass is not a full CI pass; fix a red `main` before merging unrelated work.
- The public name is TotalFinance. Publish only `@insiderfinance/totalfinance` and the optional
  `@insiderfinance/totalfinance-mcp`, from `distribution/*`. `packages/*` and their aliases are
  private source/build workspaces. After a Changesets version bump, run `pnpm publication:update`
  to synchronize source versions and derived export maps before building.
- Never publish packages, change release versions, deploy the site, or enable live execution
  without explicit maintainer approval. Never add credentials or private application code.
- Agent instructions have one source of truth: this file. If an agent does not discover
  `AGENTS.md` automatically, load it explicitly. Do not add a duplicate `CLAUDE.md`; put new
  repository instructions here.

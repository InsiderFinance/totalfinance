# Signed leg constructors — pre-release simplification

Status: implemented and locally verified complete (2026-09-09). Authorized by the maintainer after the first-call documentation
review. This bounded API amendment takes precedence over historical named-direction leg guidance.
`implementation-order.md` owns its place in the launch queue.

## Contract

There is one leg model: instrument kind plus signed position quantity. Positive means long;
negative means short. This is held exposure, not an individual buy/sell/close instruction.

- Canonical constructors: `legs.call({ strike, quantity, premium?, expiry?, impliedVolatility? })`,
  `legs.put` with the same fields, and `legs.stock({ price, quantity })`.
- `quantity` is required, finite and nonzero, with no inferred direction or size. Options are in
  contracts, stocks in shares. The Position multiplier continues to scale options only (default 100).
  Preserve the existing fractional-quantity analytical contract; do not add an execution-lot policy.
- Option premium and stock price are per share. Preserve raw LegInput premium semantics and optional
  model pricing. Optional expiry and per-leg implied volatility follow the existing position contract.
  Constructor requests are closed, with typed, field-naming validation errors; neither malformed
  inputs nor unknown keys may silently produce a leg. Outputs are ordinary LegInput/Leg records.
- Raw `strategy(legObjects, config)` remains fully supported. App state can hold those records,
  change signed quantities or other fields, and rebuild an immutable Position without a preset.
- Delete `legs.longCall`, `legs.shortCall`, `legs.longPut`, `legs.shortPut`, `legs.longStock` and
  `legs.shortStock`. No pre-release aliases, deprecations or hidden parallel implementations.
- Keep the complete named **Position** preset catalog, including single-leg presets. Presets
  deliberately name their direction and default their positive structure count to one; migrate
  their compositions to the new constructors without changing size, direction, provenance,
  classification, defaults or numerical results. Preserve rejection of negative/zero preset sizes.
- No new MCP operations or alternate wire leg grammar. Existing transport operations keep their
  signed raw records and named Position preset contracts. This amendment does not authorize live
  trading, changing the app's default calculation engine, package publication or production deployment.

## Ordered acceptance

- [x] Implement all three constructors and remove the six retired namespace members. Preserve
      optional model premiums, per-leg expiry/volatility and stock share units.
- [x] Prove runtime and TypeScript contracts: both signs, scaling, missing/zero/non-finite/wrong-type
      quantity, malformed objects and optional fields, typo keys, retired names and required quantity.
      Check constructor/raw parity for payoff and mark-to-market/Greeks, including edited custom legs.
- [x] Migrate every named preset, scanner, internal consumer and fixture; assert all catalog presets
      still classify and preserve positive-size enforcement. No sign inversion during migration.
- [x] Update first-touch identities, manifest curation, copied playgrounds, release-smoke examples,
      package/public docs and the current alignment/launch trackers. Preserve historical findings as
      history with a supersession note. Teach the three constructors and raw-record editing together.
- [x] Regenerate signatures, naming, contracts, enforcement, validation projections, API reports,
      README/agent/reference content, bundles, OpenAPI and documentation inventories in lawful order.
      All new public paths receive first-touch and measured enforcement evidence.
- [x] Run focused domain/contract tests, installed-artifact copied examples, strict typechecks, full
      CI, generated-artifact checks and the rebuilt docs site. Record actual evidence and the next
      launch step; do not claim hosted or browser certification from local tests.

## Acceptance evidence (2026-09-09)

Implementation is `9b202d6d`; exact fixture/prose counters are reconciled in `bc2af34f` and
`d2da915c`. The evidence below was collected on `d2da915c`, Node 26.5.0, pnpm 10.32.0. The
subsequent closeout changes tracking prose only.

- `pnpm run ci`: **545 files / 11,968 library tests passed**, plus **79 site tests**. Formatting,
  lint, root/site typechecks, builds, all coverage floors and all 25 API reports passed.
- `pnpm regen:check`: passed from a clean commit; the complete ordered generation chain is
  byte-stable. No generated artifact was hand-edited to pass a gate.
- `packages/strategy/test/legs.test.ts`: 70 tests cover the three constructors and every one of
  the 58 named presets, including both signs, raw-record parity, ratios, share/contract scaling,
  model premiums, per-leg inputs, malformed requests and preset direction preservation.
- `tools/packed-consumer.test.ts`: 60 tests passed. The new constructor/required-quantity/retired-name
  fixtures compile and run from installed tarballs under NodeNext and Bundler resolution; all
  24 exact first-call/full playground copies also typecheck and reproduce their displayed results.
- All nine public exposures of the three constructors are measured `enforced`. The complete
  inventory has 7,775 public callables, 5,317 measurement candidates and **0 defective** records;
  the 186 explicitly unmeasured records are unchanged. All 1,294 hand-written fixture/contract
  joins validate. Exact-count gates were updated for the deliberate surface reduction, not relaxed.
- The rebuilt site contains 1,173 routes, 9,731 export paths and 46 operations. The existing local
  preview responds HTTP 200. These checks do not certify manual browser accessibility, a hosted
  supported-Node matrix, publication rights or production deployment.

**Next:** return to the organization/hosted-CI prerequisites and domain/browser/hosting acceptance
in `implementation-order.md`'s preview launch queue. No core phase is reopened by this amendment.

## Migration

`legs.longCall({ strike: 100, premium: 6 })` becomes
`legs.call({ strike: 100, premium: 6, quantity: 1 })`.
`legs.shortCall({ strike: 110, premium: 2, quantity: 3 })` becomes
`legs.call({ strike: 110, premium: 2, quantity: -3 })`.
The same rule applies to puts. An omitted stock size previously meant 100 shares: preserve that
explicitly as `quantity: 100` or `quantity: -100` when migrating an existing example.

Do not negate an already-signed app quantity. Do not route a negative quantity into a named
whole-strategy preset. Remove zero-size rows before constructing a nonempty active strategy.

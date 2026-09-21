# TotalFinance — Lovability & Developer Experience Review

> **Historical review at `2707bbcf`–`86326290`.** Current statuses and decisions live in
> [`library-alignment-spec.md`](./library-alignment-spec.md); statuses are not tracked here.
> Frozen-text errata only: F25's claim that `QuantError` serializes to `{}` is wrong (it
> serializes `name`/`code`/`context`; only `message` is missing); §1's "architecture hits
> the 10/10 bar" conflated the substrate with the public surface; §10's one-cycle-alias
> advice is superseded by spec D5. F16/F41's positional-kernel exception is also retracted:
> moving kernels to expert subpaths fixed topology, not argument safety. Alignment Law 14 / D13 and
> Phase 3A required named objects for financially confusable scalars at every public layer; that
> correction completed on 2026-07-22. See the alignment spec for generated inventory and gate
> evidence. **Naming erratum (2026-07-28):** F12–F16 and §§10.4.2–10.4.3/10.5 retain the old
> recommendation to expose `bs`, `vol`, `iv`, `t`, and generic `rate` as compact public grammar. That
> recommendation is retracted by the repository-wide
> [Phase 3B.N naming specification](./specs/phase-3b-public-naming-normalization.md). The historical
> examples and scores below remain frozen to their stated review commits.

**Scope:** PR #303 (`insiderfinance/287-open-source-quant-library`), reviewed at `2707bbcf`; addendum covers the 40+ commits added after review (through `e5dee5cb`), see §9. Also checked `490ee0c1` (Ledoit-Wolf single-index shrinkage target) — same covariance family as §9.2, changes no finding.
**Date:** 2026-07-16 (addendum 2026-07-18; adversarial cross-review of the companion assessment 2026-07-19, §10)
**Goal posed:** Is this a 10/10 developer experience — the most-loved library, not just in TypeScript but in any language? Did we hit the mark? What must change?

**Method:** Six parallel reviewers read the full source of every package group (options/vol/structure, strategy/ta, core/math/calendars, performance/risk/backtest/fixed-income, mcp/agent-surface, docs/packaging). Independently, a hands-on session played a brand-new user against the **built** library: `pnpm install && pnpm build`, README examples verbatim, natural mistakes on purpose, an iron condor end-to-end, an SMA-cross backtest, and the MCP server driven over raw stdio JSON-RPC like a real host. Every finding marked **(verified)** was executed, not inferred. File:line references are against `2707bbcf`.

---

## 1. Executive verdict

**The architecture hits the 10/10 bar. The experience is ~8.5 today.** The substrate — teaching errors with stable machine codes, the `.explain()` envelope, the `asOf` time grammar, honesty diagnostics, docs executed in CI — is category-defining; no quant library in any language has an equivalent (§4 has the receipts). What separates this from "most-loved" is:

- **Three first-five-minutes landmines** — the README quickstart prints NaN, the strategy guide's headline example crashes, and the install story 404s everywhere (F1, F2, F10).
- **Six violations of the library's own laws** — silent wrong numbers and raw TypeErrors in exactly the places the design laws promise they can't exist (F3–F6, F20).
- **One agent-surface miss** — the flagship MCP tool cannot accept an expiry date (F7).
- **A set of now-or-never pre-1.0 naming/consistency items** — the one-gesture law breaks in vol/structure, `iv` vs `vol`, umbrella grammar mixing (F11–F22).

Everything on the P0 list is hours of work, not days. Fix P0 + the pre-1.0 renames and this credibly becomes the most-loved quant library, full stop.

## 2. Scoreboard

| Surface                    | Score | One-liner                                                                 |
| -------------------------- | ----- | ------------------------------------------------------------------------- |
| @totalfinance/options      | 9     | Flagship task is one obvious call; thin hover-docs + IV entrypoint sprawl |
| @totalfinance/vol          | 7.5   | Superb analytics; breaks the library's own one-gesture law                |
| @totalfinance/structure    | 8.5   | Best GEX API in any language; convention error doesn't teach              |
| @totalfinance/strategy     | 8.5   | Best options-calculator API anywhere; guide crashes, 4 raw TypeErrors     |
| @totalfinance/ta           | 9     | Ergonomically ahead of TA-Lib/pandas-ta; one silent-miscompute trap       |
| @totalfinance/performance  | 9.5   | First-touch experience is literally CI-tested; frictionless               |
| @totalfinance/risk         | 9     | Best-in-class convergence honesty; covariance on-ramp missing             |
| @totalfinance/backtest     | 9     | 3-line first backtest; one copy-paste trap, one missing primitive         |
| @totalfinance/fixed-income | 9     | Street-perfect naming; one name collision, two envelope gaps              |
| @totalfinance/core         | 9     | Best-in-class substrate; `/schema` surface invisible in API report        |
| @totalfinance/math         | 9     | Worth publishing standalone; throw-vs-report split undocumented           |
| @totalfinance/calendars    | 8     | Rules-based and correct; no first-class "trading days to expiry"          |
| @totalfinance/mcp          | 8.5   | Best MCP tool surface we've evaluated; drift + a date-blind flagship tool |
| Onboarding / docs          | 7     | World-class machinery; stale numbers + NaN quickstart on the front page   |
| npm packaging              | 8.5   | Near-flawless manifests; no `default` condition, placeholder repo URLs    |

## 3. What is genuinely world-class (do not touch)

These were stress-tested, not just admired. They are the moat; every fix below should preserve them.

1. **Teaching errors as a system.** Named function that survives minification, stable greppable codes, received value echoed. Verified live: missing field → `bs.call: vol must be a finite number. Received undefined.`; enum typo → `bs.price: type must be one of call, put; got "Call"` (never coerced, never prices the wrong leg); positional misuse → `bs.call: expected an input object of named fields as the first argument, got number.`; wrong strategy keys → expected shape **plus** the keys you actually passed; retired keys teach their replacement; `buildStrategy('IronCondor')` → "Did you mean 'ironCondor'?" (`core/errors.ts:105-127`, `core/facade.ts:24-45`, `strategy/manifest.ts:450-460`). Recovery from any wrong call is one round trip.
2. **Unit-footgun warnings.** `vol: 22` → "implies 2200% volatility — did you mean 0.2200?"; `t: 30` → "if you meant 30 days, use 30/365 = 0.0822" (`core/diagnostics.ts:88-144`). Catches the two classic silent-wrong-answer mistakes of every options library ever. No peer in any language.
3. **The time grammar.** One `asOf` grammar (epoch ms / `YYYY-MM-DD` / zoned ISO) everywhere; zone-less datetimes **rejected with the fix in the message** ("a bare datetime would silently parse in the machine's local zone"); `2026-02-31` rejected, not rolled to March; date-only expiry resolves to 16:00 ET DST-aware so 0DTE contracts don't vanish intraday (`core/time.ts:37-109`, `core/dates.ts:32-42`). The most footgun-free date handling seen in a JS finance library.
4. **The honesty architecture.** `maxSharpe` refuses to stamp a min-variance fallback as success (`risk/optimize.ts:663-688`); infeasible tangency → NaN weights + `converged: false` + teaching warning; Kelly refuses to sign-flip a net-short book; Cornish-Fisher VaR discloses its CVaR fallback; `executionLag: 0` flagged as look-ahead (`backtest/vectorized.ts:338-345`); risk-neutral outputs carry an "estimate, not a forecast" warning; IV rank on flat history → NaN + warning, never fabricated.
5. **Strategy market memory + derived identity.** Build an iron condor with per-leg premiums, then **zero-argument** `metrics()` → net credit, max P/L, breakevens (verified: `{netCredit: 130, maxProfit: 130, maxLoss: -370, breakevens: [93.7, 106.3]}`). With `{premiums: 'model', market}`, `probability()` with no arguments returns PoP/EV — call economy no Python library or optionsprofitcalculator-class tool has. `constructedAs` provenance via non-exported symbol; `classifyStrategy` recomputes identity structurally with a CI round-trip law so classifier and builders cannot drift (`strategy/classify.ts:1-23`). Breakevens computed analytically from the kink set, not grid-sampled (`strategy/position.ts:395-458`).
6. **TA batch derived from stream.** Batch≡stream parity is structural, not tested-for (`ta/framework.ts:1-14`); warmup disclosed in `explain().diagnostics.warmup` and measured by `indicatorWarmup()`; forming-bar `update()` (peek without commit — closed bars never repaint) is inexpressible in TA-Lib or pandas-ta; alias-aware `describeIndicator('RSI')` returns params/defaults/warmup/cross-library aliases in one card; `talib: true` bit-exact modes with an honest differences doc.
7. **Docs that cannot rot (machinery).** Every TypeScript block in a root README compiles and executes in CI (`docs/examples/readme.test.ts` via `tools/readme-exec.ts`); per-package READMEs generated and drift-checked; a CI-budgeted five-minute journey (`docs/examples/five-minute-journey.test.ts:52-64`); `llms.txt`/`llms-full.txt` generated from the registry; every declared subpath imported in CI (`tools/monorepo-entrypoints.test.ts`).
8. **MCP fundamentals.** Uniform `{value, assumptions, diagnostics}` payloads; per-Greek units echoed; NaN→null normalized at both layers; deterministic seed policy (injected, echoed in `assumptions.seed`, published as a `totalfinance://policy/seed` resource, bit-identical reproducibility tested); compute budgets enforced by validation before work (5000-row caps, 64 KB arg budget, 1M MC sample cap); discovery companions (`technical_analysis.list`/`technical_analysis.describe`, `strategy.list`) instead of 335 micro-tools. The cold-agent test: option pricing and RSI succeed on the first call; iron condor on the second (the error teaches the shape).
9. **Engine transparency.** `engines.auto()` picks BSM/Black-76/BS2002/Leisen–Reimer by contract and reports **why** in `diagnostics.autoReason`, including the negative-rates exception to the American-call theorem; `compareEngines` exists (`options/engines.ts:472-597`). QuantLib makes you know this; TotalFinance teaches it.
10. **Packaging hygiene (mechanically verified).** All exports-map targets exist on disk; `types` first in every condition block; LICENSE + README + `files` allowlist + `publishConfig` + `engines` in all 14 packages; node16 strict `tsc` resolves root and deep subpaths; MCP bin has its shebang; per-feature deep entrypoints (31 in ta, 15 in math) with an enforced bundle budget.

---

## 4. P0 — fix before merge/launch (trust breakers; hours each)

### F1. The README hero example prints 14 NaNs (verified)

Every RSI example in the project feeds exactly 14 closes to RSI-14 — entirely warmup: `README.md:63`, `docs/getting-started.md:14`, `packages/ta/README.md:16-21`, `docs/examples/readme-snippets.test.ts:152-161`, `five-minute-journey.test.ts:18-21`. Ran it: `[NaN ×14]`. The snippet executor asserts compile+no-throw only (`readme.test.ts:12-14`), so this semantic rot is invisible to CI. The first number a curious visitor prints must not be NaN.
**Fix:** use Wilder's classic 15+-value dataset; make snippet tests assert `expect(rsi.at(-1)).toBeCloseTo(…)` — closing the executor's blind spot for all snippets at once.

### F2. The strategy guide's headline example throws (verified)

`docs/guides/strategies.md:16-24` uses the **retired** `premiums` top-level key (rejected by `builders.ts:164-169` with the "premiums live on each leg" teaching error) and the renamed `underlyingPrice` (now `spot`, `probability.ts:17`). First doc hit for "totalfinance iron condor" crashes on line one. The CI-verified `docs/examples/strategies.test.ts` is correct — the guide was never regenerated.
**Fix:** update the snippet; put guide snippets under the same CI harness as README snippets (infrastructure already exists).

### F3. `technical_analysis.rsi(closes, 7)` silently computes RSI-14 (verified)

`framework.ts:512` — `resolve = (params) => params ?? ({} as Params)` lets a primitive through; `(7).period` is undefined so the default engages. Every TA-Lib/tulind/pandas-ta user's muscle memory (`talib.SMA(close, 30)`) produces a **silently wrong number** — the exact class DX3 exists to kill. `sma(closes, 20)` happens to throw only because sma has no default period; same mistake, two behaviors.
**Fix (one line, covers all 335 indicators):** in `resolve`, throw a typed teaching error when `params` is defined and not a plain object: `rsi: params must be an object — rsi(series, { period: 7 })`.

### F4. First-touch law violations on `Position` methods (verified)

`payoff()`, `chartData({})`, `scenarioTable({})`, `whatIfCube({})` throw raw `Cannot read properties of undefined` (`position.ts:461-463, 936, 1022, 1156`) — the natural next calls after zero-arg `metrics()` works. Meanwhile `payoffSvg(pos)` already derives a default range from the strikes (`svg.ts:140-157`). The enforcement sweeps cover exported functions but not class methods.
**Fix:** give `payoff()`/`chartData()` the payoffSvg strike-derived default range (best) or a `requireArgObject` teaching error; **extend the garbage ratchet to class methods**. Also: `payoff({ prices })` — `prices` is a _range_ `{from, to}`, not an array; `payoff({prices: [85, 95, 105]})` fails confusingly (verified). Rename to `range` or accept an array too.

### F5. Backtest docs teach a silently wrong strategy

`signals.ts:16-33` — the flagship example feeds `crossOverSeries(fast, slow)` (1 **only on the crossing bar**, `signals.ts:117-140`) as the position signal: long for one bar per golden cross, then flat. Copy-paste yields silently wrong results with zero warnings.
**Fix:** example should use `gtSeries` ("long while fast above slow"); demote `crossOverSeries` to event detection. **Add `latchSeries(entries, exits)`** (~30 lines) — without it, "enter on crossover, exit on crossunder" (the most common retail strategy shape) is inexpressible in the vectorized engine.

### F6. `legs.longCall({ quantity: -1 })` silently builds a short call (verified)

**Superseded before release (2026-09-09):** the original finding and repair below are historical.
The accepted [signed-leg constructor contract](./specs/signed-leg-constructors.md) removes the
six direction-specific leg helpers in favor of `legs.call`, `legs.put` and `legs.stock` with
required signed quantities. Positive-count enforcement remains on named whole-Position presets.

`legs.ts:33` — `sign * (input.quantity ?? 1)` with no positivity check; `classifyStrategy` then reports `shortCall`. The function name is a promise about direction.
**Fix:** reject `quantity <= 0` in named-direction builders with "quantity must be positive — use legs.shortCall for the short side" (signed quantities remain available via raw `strategy(legs)`).

### F7. The flagship MCP tool is date-blind (verified)

`totalfinance.option.price` requires `t` (years) and rejects `expiry`/`asOf` as unknown fields — while `strategy.analyze` legs accept `expiry` date strings in the same server. The natural agent call (`{spot, strike, expiry: '2026-09-18', asOf: '2026-07-16', …}`) fails, and the structured error "corrects" the agent into doing calendar math in its head — forfeiting the day-count rigor that is the library's whole point.
**Fix:** accept `expiry` + `asOf` (keeping `t`) on `option.price` / `option.greeks` / `option.implied_volatility`, echoing the resolved `t` in assumptions.

### F8. MCP drift cluster

- **19 vs 20 tools:** `docs/guides/mcp.md:61`, `README.md:116`, and `tools.ts:1130` say 19; the server registers 20 (12 in `tools.ts:1131-1147` + 8 in `tools-analysis.ts:609-620`); the guide omits `totalfinance.ta.describe` entirely. Generated `llms.txt` and the test suite correctly say 20. Generate the counts.
- **"8 packs" is a misnomer:** exactly one pack exists (`backtestPack()`, `tools-analysis.ts:706-708`); the "8" are tool families that are **not** individually opt-in. Either reword, or export `optionsPack()`, `taPack()`, … so hosts compose the surface (the arrays already exist — this is the 10/10 move).
- **Seed default mismatch:** schema documents `seed` "default 1" (`tools.ts:1061`) but the server injects `defaultSeed ?? 0` (`server.ts:123, 174-176`) — an agent reading the schema predicts different bit-exact results than it gets. Align on 1 or reword to point at the seed policy.

### F9. The IV schema is description-less exactly where agents guess wrong

`options/schema.ts:33-41` — `BsmImpliedVolInputSchema` leaves `spot/strike/t/rate/dividendYield` undocumented (bare `"t": {"type":"number"}` in the generated schema), contradicting the guide's "every numeric field states its unit convention" (`mcp.md:93`). Worse: IV with `t` in days fails as `implied_volatility.below_intrinsic` with zero unit hint — the one place a cold agent can flounder with no recovery signal.
**Fix:** build the IV schema from `bsmShape` so descriptions ride along; fire the suspicious-time/vol warnings on the IV path too.

### F10. Launch-ops fiction + packaging blockers

- **Nothing is installable:** `totalfinance` and `@totalfinance/*` are not on npm; `github.com/InsiderFinance/totalfinance` 404s; yet `README.md:11,55-57,120-122` speak in the present tense (`pnpm add totalfinance`, `npx -y @totalfinance/mcp`). Claim the npm scope **now** (name-squatting alone justifies it — `totalfinance` is unclaimed) or change the status line to "not yet published."
- **`TODO(repo-url)` ships in all 14 manifests** and every generated README's three links (`readme-gen.ts:18-20` hardcodes the URL; e.g. `packages/options/package.json:19-24`). Single-source `REPO_URL` from `package.json.repository`.
- **No `default` export condition** → `require('@totalfinance/options')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` even on Node ≥20.19 which supports `require(ESM)` (verified on Node 24). Add `"default": "./dist/index.js"` after `"import"` in every condition block; document "ESM-only; Node ≥18 import, Node ≥20.19 require" in README + getting-started.
- **Stale, mutually contradictory front-page numbers:** phases 0–5 vs roadmap's 0–6; "2,178 tests" vs "5,000+"; "19 tools" vs 20. For a library whose brand is "the front page cannot lie," each stale number is disproportionately damaging. Generate them or remove them.
- **The envelope guide documents a deleted API:** `docs/guides/envelope.md:27-31` teaches `SeriesResult<{value, warmup}>` — deleted in R1 (`ta/framework.ts:99-102`); the real story (one envelope, `diagnostics.warmup`, zero exceptions) is better. Rewrite.
- **Sourcemaps reference unshipped `../src`** (`declarationMap`+`sourceMap` on, `files` excludes src) — go-to-definition and debuggers hit missing files. Ship `src/` (enables true go-to-definition) or drop maps from the publish build.
- **Changesets fixed group `[["@totalfinance/*"]]` misses the unscoped `totalfinance` umbrella** (`.changeset/config.json:6`) — versions drift at the first bump. Dead globs: `@totalfinance/example-*` ignore and `examples/*` workspace entry reference a nonexistent directory.
- **README front page reads like a spec:** a ~38-line single-paragraph status wall with 15+ bold subclauses before any code; no badges/TOC; pnpm-only install. Compress to 3 bullets + milestones link; npm-first (or tabbed) install. The "One line / When you need the assumptions / Professional control" ladder is already Zod-quality — lead with it.

---

## 5. P1 — pre-1.0 (naming is now-or-never)

### F11. vol/structure lack the `.explain()` gesture entirely — the one-gesture law breaks

Zero `facade(` uses in either package (grep-verified). In options, the simple path returns a plain value; one import later, `expectedMoveFromIv({...})` always returns an envelope (`.value.oneSigma` tax; `vol/event.ts:59-86`), `ivRank` likewise (`metrics.ts:43-75`) — and it's mixed **within one file**: envelope-always next to plain-scalar (`realizedImpliedSpread`, `event.ts:226`) next to plain-object (`eventVolDecomposition`, `event.ts:268`). No rule a user can predict. **The single highest-leverage consistency change:** wrap the scalar tier in real facades (plain value; `.explain()` for the envelope with the risk-neutral caveat — exactly how `bs.*` handles unit warnings).

### F12. `iv` vs `vol` field naming inconsistent inside @totalfinance/vol

`ExpectedMoveIvInput.iv` (`event.ts:52`) vs `ProbabilityInTheMoneyInput.vol` (`event.ts:141`) and `ProbabilityOfTouchInput.vol` (`event.ts:183`) — same quantity, two names, one module. Options uses `vol` everywhere. Standardize on `vol`; accept `iv` as deprecated alias one cycle.

### F13. `fit*` vs `calibrate*` and acronym casing split in vol

`fitSVI`, `fitSABRSmile`, `fitGarch`, `fitEventVol` vs `calibrateSSVI`, `calibrateHestonSurface`, `calibrateEventMove`; casing splits `fitSVI` vs `sviVol`/`ssviVol`/`sabrVol` (`vol/index.ts:26-170`). Pick one verb (`fit`) and one casing rule (lower acronym: `fitSvi`, `fitSabrSmile`), alias old names, or document the fit/calibrate distinction where users can find it.

### F14. fixed-income `zeroRate` means two opposite things

`curves.zeroRate(points, opts)` **builds** a curve (alias of `fromZeroRates`, `curves.ts:666`); `curve.zeroRate(date)` **queries** one (`curves.ts:84`). Deprecate the builder alias.

### F15. Error-code registry leaks (codes freeze at 1.0)

- `time.ts:41` throws raw string `'time.timezone_resolution_failed'` — not in the `ErrorCode` registry.
- QR eigenvalue non-convergence uses `SolverNoConvergence` (`linalg.ts:739-740`) while `jacobiEigen` uses `LinalgNoConvergence` (`linalg.ts:146-147`) — branching on `linalg.no_convergence` silently misses the QR case.
- `wrongShapeError` is coded `input.missing_field` but is a shape/type error (`errors.ts:117-127`) — recode `input.wrong_type`.
  **Lock it permanently:** a conformance test asserting every `code:` literal in the monorepo appears in a registry.

### F16. Umbrella grammar mixing — 94 flat top-level exports (verified)

`export * from '@totalfinance/options'` hoists object-shaped `bs.price({...})` **and** positional kernels `bsmPrice(type, S, K, T, r, q, sigma)`, `bsmGreeks`, `black76Price`, plus `DEFAULT_OUTLIER_THRESHOLD`, schema constants, `bsmPriceManyInto` into one autocomplete list — two calling grammars, same prefix. Misuse produces a confusing error (`bsmPrice({...})` → "type must be one of call, put; got {whole object}"). Keep kernels importable, but move them out of the flat namespace (a `kernels.` namespace or subpath-only) before 1.0 freezes the surface.

### F17. Backtest `Bar` vocabulary friction (verified)

Bars require `{symbol, ts, open, high, low, close}`; natural keys `time` (lightweight-charts) and `timestamp` are rejected; `symbol` is mandatory for single-asset runs. TA bars (`{high, low, close, …}` via `barsFromColumns`) are not valid backtest bars — interop is one-directional (TA accepts backtest bars; verified). The teaching error is good, so recovery is fast, but the friction is unnecessary.
**Fix:** accept `time`/`timestamp` aliases, default `symbol` for single-asset runs, or ship `backtest.barsFrom({...})`.

### F18. Risk optimizers have no covariance on-ramp

Every optimizer demands Σ; `covarianceMatrix` lives in `@totalfinance/math` (`linalg.ts:60`), is **not re-exported from risk**, appears in zero docs — and its rows=assets shape conflicts with `cvarOptimize`'s rows=scenarios (`optimize.ts:1266`). This is the one wall in an otherwise 9/10 package.
**Fix:** re-export `covarianceMatrix` + a `meanReturns` helper from risk; state rows/cols in both JSDocs; show returns→cov→minVariance in the risk README. Also: `portfolioVaR(weights, input, {method})` umbrella — portfolio VaR is currently two separately-named functions and **historical portfolio VaR doesn't exist** (arguably the most common in practice).

### F19. Per-member JSDoc missing on the flagship namespaces

Hovering `bs.call` shows only `Facade<BsmInput, number>` (`black-scholes.ts:259-278`) — no description, no `@example`, on the most-used function in the library. Same for `option.call`/`callContract`/`putContract` (`contract.ts:31-39`). The input fields are well documented (`BsmInput`), which saves it. Zod's lovability is substantially hover-docs. Add one-line docs + `@example` per member; include `@see impliedVolatility` on `bs.impliedVolatility` to explain the layering (F22).

### F20. Missing-field errors should say "required"; suspicious-rate guard missing (verified)

- Omitted field reads as a type complaint: "rate must be a finite number. Received undefined" vs fixed-income's "issueDate is required. e.g. …". One branch in `core/invariants.ts:12-19` upgrades every facade: `undefined` → `"${fn}: ${field} is required (e.g. rate: 0.045 — a decimal)."`
- `rate: 4.5` (450%) prices **silently** — no warning anywhere, while `vol` and `t` both have plausibility guards (verified: warnings array empty). Add `input.suspicious_risk_free_rate` for `|rate| > 0.5` — in the library and MCP both.

### F21. MCP agent-ergonomics cluster

- `technical_analysis.list` with no args returns 335 indicators / **41 KB** (and the compact mirror rides twice via `content` + `structuredContent`). Default `limit` ~50; lead the description with `search`.
- `technical_analysis.calculate` field-level guidance is TS comments, invisible in the generated schema — add `.describe()` per field (`tools.ts:200-228`).
- `mcp.input_too_large` states byte counts but no remedy — uniquely non-teaching (`server.ts:179-181`).
- `SERVER_INFO` version hardcoded `'0.0.1'` (`server.ts:60`).
- Prompts are thin: two, options-only; `screen-options-chain` presumes chain data the server can't fetch. Showcase `strategy.analyze` + `structure.exposures`.
- **Dotted tool names** (`totalfinance.option.price`) are a host-compatibility risk: OpenAI-style function-name validation (`^[a-zA-Z0-9_-]+$`) rejects dots when hosts pass names through unsanitized. Verify against target hosts; underscores are the maximally-compatible choice.
- `docs/guides/mcp.md` never documents `deadlineMs`/`maxInputBytes`/`defaultSeed` server options; the deadline is post-hoc (honest in code, absent in docs).

### F22. Generated per-package READMEs undersell every package

One trivial line each: ta's shows only `rsi.explain` — nothing about `.stream()`/`update()`/live charts (the differentiator), macd/bbands, bars input shape, or the signal DSL; strategy's 34 lines never mention the 58 builders, model premiums, `probability()`, or `explainPosition`; calendars' shows `isBusinessDay` while `expirations`/`nextExpiry`/holiday-shifted OPEX are invisible; core's shows `isoDateToEpochMs` instead of the envelope. The npm page is the storefront. Teach `readme-gen.ts` to inject 2–4 curated CI-run snippets per package + a guides link block (snippet-CI infrastructure already exists). Show outputs in examples (`// => { netDebit: 285, … }`) so the ×100 contract multiplier is unsurprising.

---

## 6. P2 — polish (post-launch is fine)

- **F23. Calendars:** add `tradingDaysToExpiry(calendar, asOf, expiry)` (today's answer — `NYSE.businessDaysBetween` with half-open `(from, to]` semantics documented only in `core/calendar.ts:38-39` — is not named for the question traders ask). Expose `holidays(year)` (the rule engine computes it internally, `calendar.ts:156-177`) and epoch-ms session instants (`session()` returns local `HH:MM` strings; "is the market open at this asOf?" requires hand-rolled tz math core itself does carefully elsewhere).
- **F24. Time:** `resolveAsOf(NaN)` accepted silently (`time.ts:87`) — reject non-finite. Missing-asOf error should add "TotalFinance never reads the system clock — pass `asOf: Date.now()` if you mean now." Document the asOf/expiry asymmetry (date-only asOf → UTC midnight; date-only expiry → 16:00 ET) side by side in getting-started. `optionExpiryToMs` hardcodes the US-equity close with no override — a Deribit BTC expiry (08:00 UTC) silently gets a US timestamp; accept a close-resolution argument or a `Calendar`.
- **F25. Core odds and ends:** `QuantError` serializes to `{}` — add `toJSON()` returning `{name, message, code, context}` (`errors.ts:19-31`); `NullSchema` unexported → TS4023 for declaration-emitting consumers (`schema.ts:795-807`); the `/schema` entrypoint is invisible in the API report/README ("2 entrypoints" claimed, zero schema exports shown — make `tools/api-report` walk every exports-map entrypoint); `Assumptions.calendar`/`calendarVersion` declared but never populated by any package — populate or mark reserved.
- **F26. TA streaming naming hazard (verified):** `update()` is peek-only (never commits); feeding 60 values via `update()` yields null forever while `next()` gives batch parity. The JSDoc is clear (`framework.ts:88-97`) but the most natural feed-method name silently does nothing permanent. Consider a `peek` alias and a README batch→stream example. Also `getIndicator`/`hasIndicator` are exact-name while `describeIndicator`/`resolveIndicator` are alias-aware (`registry.ts:205-210`) — false negatives on every TA-Lib spelling; route through `resolveIndicator`.
- **F27. Options pro-tier types:** `OptionMarket` can't express vol-required-for-pricing at compile time (`types.ts:66-74`) — overload `priceOption` with `& { vol: number }` (and IV with `& { price: number }`); fix the `volatility`→`vol` doc comment; make contract `underlying` optional (pricing never uses it; you can't build a contract without inventing `'XYZ'`). IV thrown errors drop the function-name prefix (`facade-util.ts:74-84`) — prefix with the facade label and include price vs intrinsic numbers. README shows `result.greeks.delta` but `greeks` is optional — type analytic engines with required greeks or show the guard.
- **F28. Structure:** the required-`convention` error doesn't teach the three convention strings or show a call (`exposure.ts:388-393`) — the library's own `missingFieldError` bar. Consider defaulting `rate` to 0 with echo + info warning for the dashboard persona. `SurfaceConfig.minQuotesPerExpiry` documents strikes, name says quotes (`vol/surface.ts:91-92`).
- **F29. Backtest/performance/FI polish:** `optionsBacktest` (declarative condor entry by delta, profit-target/DTE exits, rolls — a differentiated feature) is invisible from the root entrypoint/README — name it. `toEquityPoints` emits two points with the same timestamp (`types.ts:146-155`) — document `points.slice(1)` or back-stamp the opener. Optimizer results nest the payload at `result.value.weights` — defensible (convergence must not be droppable) but note it in docs. `returnStats` re-implements hitRate/profitFactor/expectancy instead of delegating to performance — drift risk. `yieldToCall` (a Brent root-find returning a bare number) and `priceMultiCurve` should be facades like their siblings (`bonds.ts:869, 919`). Solver throw-vs-report rule (searches report, decompositions throw) — one paragraph in the math README. `@default` tags on all option interfaces (tolerances/max-iterations live only in source).
- **F30. Docs/site:** llms.txt is generated and excellent but nothing links to it; typedoc covers 7 entrypoints across 4 of 14 packages — expand or stop presenting it as "API docs" (`docs/README.md:83-90`); add CONTRIBUTING/SECURITY/CODE_OF_CONDUCT/.github CI ("2,178 tests pass under pnpm run ci" currently describes a local script with no public CI behind it); a one-line "npm snapshot may lag this README until launch" disclaimer for the pinned-0.0.1 policy.
- **F31. Micro:** importing `{ performance }` from `totalfinance` shadows Node's global `performance` in that module — docs note only. `strategy.probability()` returns metrics-with-assumptions while `value()`/`scenarioTable()` return full `Computed` and `metrics()`/`payoff()` return bare objects — three result shapes on one class; document as tiering.

---

## 7. Hands-on evidence (what a first-time user actually sees)

| Probe                                                             | Result                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `bs.call({spot:100, strike:105, t:30/365, rate:0.045, vol:0.22})` | ✅ `0.8983963669668142` — matches README                                             |
| `technical_analysis.rsi([…14 closes])` (README verbatim)          | ❌ `[NaN ×14]` (F1)                                                                  |
| `bs.call.explain(...)`                                            | ✅ dayCount, compounding, greek units, `converged: true`                             |
| `bs.call` missing `vol`                                           | ✅ teaching error, stable code                                                       |
| `bs.price` with `type: 'Call'`                                    | ✅ enum error; never priced the wrong leg                                            |
| `bs.call(100, 105, …)` positional                                 | ✅ "expected an input object of named fields"                                        |
| `bs.call({vol: 22})`                                              | ⚠️ silently 99.8 (plain path — by design); `.explain()` warns "did you mean 0.2200?" |
| `bs.call({rate: 4.5})`                                            | ❌ silently 27.46; **no warning anywhere** (F20)                                     |
| unknown key (`strkie` typo alongside `strike`)                    | ⚠️ silently ignored (MCP rejects unknown fields — inconsistent strictness)           |
| `bsmPrice({object})` (kernel misuse)                              | ⚠️ "type must be one of call, put; got {whole object}" (F16)                         |
| `market({asOf: '2026-07-16T09:30:00'})`                           | ✅ 10/10 refusal: names the local-zone footgun and the fix                           |
| `market({asOf: '07/16/2026'})`                                    | ✅ lists the three accepted formats                                                  |
| `option.price` without engine                                     | ✅ defaults sensibly; expired contract → clear error                                 |
| `strategy.ironCondor` (wrong keys)                                | ✅ expected-shape + received-keys error; correct build → zero-arg `metrics()` ✅     |
| `condor.payoff()` / `chartData()` / `scenarioTable()`             | ❌ raw TypeErrors (F4)                                                               |
| `condor.probability()`                                            | ✅ teaching error: "Pass them in the call, or build with { market: … }"              |
| `technical_analysis.sma(closes)`                                  | ✅ "period is required. e.g. sma(series, { period: 20 }) — common: 10, 20, 50, 200"  |
| `technical_analysis.rsi(closes, 7)`                               | ❌ silently RSI-14 (F3)                                                              |
| `technical_analysis.atr(columnar)` / `(positional arrays)`        | ✅ both taught `barsFromColumns`                                                     |
| `technical_analysis.rsi.stream(...).update(×60)`                  | ⚠️ null forever (peek semantics; F26); `next()` → exact batch parity ✅              |
| `vectorized({closes, signal})` naive                              | ✅ teaching error → correct 10-line backtest ran; warmup warning surfaced            |
| backtest bars with `time`/`timestamp` keys                        | ❌ rejected; `ts`+`symbol` required (F17)                                            |
| MCP `initialize`/`tools/list`                                     | ✅ instant, 20 tools, good descriptions                                              |
| MCP `option.price` with `expiry`+`asOf`                           | ❌ rejected: `t` required, expiry/asOf unknown (F7)                                  |
| MCP bad call (`dte`, `rate: 4.5`, `Call`)                         | ✅ structured per-path issues — one-round-trip self-correction                       |
| MCP resources/prompts                                             | ✅ per-tool schemas + seed policy; 2 thin prompts (F21)                              |

## 8. Honest comparisons (from the reviewers)

- **vs py_vollib:** not close — named fields vs `('c', S, K, t, r, sigma)` flag-strings; typed teaching errors vs `BelowIntrinsicException`; practitioner greek units disclosed vs academic units; `.explain()` has no analogue.
- **vs QuantLib:** a vanilla price is ~15 lines of DayCounter/Handle/engine ceremony there with conventions hidden in object state; TotalFinance's pro tier gets the same disclosures in 3 calls with conventions echoed in the result. QuantLib retains vastly more instrument depth (bermudans throw here); for the listed-equity-options practitioner surface TotalFinance is simply more usable.
- **vs pandas-ta / TA-Lib wrappers:** ahead on every axis except README pedagogy — alignment guarantees, streaming, serializable state, alias-aware discovery, honest divergence docs.
- **vs vectorbt/empyrical:** the envelope/honesty architecture (assumptions echoed, look-ahead flagged, implementation-risk diagnostics on the result) has no equivalent.
- **vs Zod/Vitest-tier TS DX:** the error architecture and CI-run docs are at that bar; hover-docs on flagship namespaces (F19) and gesture uniformity (F11) are not yet.

---

## 9. Addendum (2026-07-18): review of `2707bbcf..e5dee5cb` (~40 commits, 140 files, +16.4k lines)

The new work is pure feature depth — SSVI/eSSVI + vanna-volga + SABR Bartlett + vol-spot beta in vol; higher-order/extended greeks across engines; Ledoit-Wolf/EWMA covariance + `estimateCovariance` in math; shrunk/cost-aware Kelly, Cornish-Fisher book VaR, Cariño linking, EVT threshold selection in risk; OAS + bond-future hedge in fixed-income; napoleon/reverse-cliquet, touch greeks, inverse (coin-settled) options in options; and a new **`@totalfinance/crypto`** package (perp funding, futures basis, carry curve, inverse futures + coin-delta hedge). Each feature ships with a spec doc, tests, and first-touch guards — the discipline held.

**Nothing from the original review was addressed.** No file tied to any P0/P1 finding changed (README, getting-started, guides, `ta/framework.ts`, `strategy/position.ts`/`legs.ts`, `backtest/signals.ts`, MCP — all untouched). Every finding F1–F31 stands as written. The diff _changes the review_ in these ways:

### 9.1 Findings that got worse

- **F10 (stale numbers) is now actively wrong, not just drifted.** `README.md:13` still says "fourteen packages (thirteen `@totalfinance/*` scoped)" — there are now 15 (fourteen scoped + umbrella). The README package table and getting-started don't mention `@totalfinance/crypto` at all; only the _generated_ `docs/llms.txt:10` picked it up. The pattern is now proven twice: generated docs keep up, hand-written numbers rot. Generate the counts.
- **F11 (one-gesture law) now spans a third grammar.** Crypto results are plain objects with `assumptions` (and sometimes `diagnostics`) **inlined as fields** (`crypto/src/carry.ts:70,115,158`) — not options' plain-value + `.explain()`, not vol's envelope-always. Three result grammars across the library, and the new vol functions (`vannaVolga`, `riskReversalButterfly`, `surfacePcaScenarios`, `volSpotBeta`) all add more envelope-embedded surface. Every week of feature work makes the facade-wrapping job bigger — this is the strongest argument for doing F11 **now**.
- **F13 (naming split) gained a new casing variant.** `calibrateESSVI` (upper acronym) now sits beside `calibrateSSVI`, `essviVol` (lower), and `fitSVI`/`fitSabr…` — three conventions in one module's export list (`vol/src/index.ts` difference).

### 9.2 Findings partially addressed (incidentally)

- **F18 (covariance on-ramp) is half-solved — the good half.** `estimateCovariance` (`math/src/linalg.ts:464`) is genuinely excellent: `'auto'` default (sample when SPD/well-conditioned, else Ledoit-Wolf shrink), EWMA with `lambda`/`halfLife`, conditioning disclosed so callers know if it's safe to invert, teaching errors, and the JSDoc states the p×T orientation. **Still missing:** it is not re-exported from `@totalfinance/risk`, appears in no risk docs, and the risk README still shows no returns→cov→optimizer path — the discoverability wall stands exactly as described. (The rows=assets vs `cvarOptimize` rows=scenarios conflict also still stands, though now at least documented on one side.)

### 9.3 New findings from the new code

- **F32. `@totalfinance/crypto` result-shape grammar** (see F11 above) — decide the gesture before this package is public; it's small enough to convert in an hour.
- **F33. Crypto is invisible from every hand-written doc.** No README table row, no getting-started mention, no guide. A whole tier launches undocumented (llms.txt aside). Fold into the F10/F22 fixes.
- **F34. Crypto has no MCP exposure.** Defensible for now (19→20 tool drift already needs fixing first), but perp funding/basis is exactly the kind of tool agents would use — note it in the MCP roadmap or the "packs" story (F8).
- **F35. New multi-arg exports and the sweep.** The new surface (e.g. `sabrBartlettGreeks`, `digital.extendedGreeks`, `calibrateESSVI`) appears to carry first-touch guards (`requireArgumentObject` etc. verified in crypto and vanna-volga), and the ratchet requires fixtures for multi-arg exports — but the **class-method gap from F4 still applies to nothing new only by luck**: none of the new code ships classes. Extend the ratchet to methods before someone does.

### 9.4 Bottom line for the addendum

The new 16k lines raise the library's _capability_ ceiling and keep the correctness discipline (guards, specs, tests everywhere — verified by spot-check). They do not move the _lovability_ needle: every landmine from §4 is still armed, and three findings (F10, F11, F13) got concretely worse because new surface accreted onto the unfixed patterns. Recommendation unchanged, with sharpened urgency: **land the P0 list and the pre-1.0 renames (F11–F16) before the next feature batch** — the cost of the gesture/naming fixes is growing linearly with every commit, and everything else in this review is cheap by comparison.

---

## 10. Adversarial cross-review of `library-developer-experience-assessment.md` (2026-07-19)

The companion document (7b673d80) is an independent parallel assessment. This section is the adversarial pass over it: every load-bearing claim was code-verified rather than accepted, its unique findings are conceded and adopted where they held, its blind spots are named, and — most importantly — the places where the two documents make **different library and philosophy decisions** are argued explicitly so a maintainer can pick a side once and move on.

### 10.1 Verification of its claims

Nearly everything checked out. Verified against source at the current head:

| Companion claim                                                                                               | Verdict                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `greeks: false` ignored by BSM/Black-76, honored elsewhere                                                    | **Confirmed** — `engine-bsm.ts:152` returns greeks unconditionally. Softener: `PriceOptions.greeks` is JSDoc'd "Reserved for future" (`engines.ts:57-59`) — so it's a half-implemented flag rather than a broken promise; engines diverging silently on a public flag is arguably worse |
| `lambda = Δ·S/price` non-finite on deep-OTM underflow, `converged: true`                                      | **Confirmed** — `bsm.ts:144`, unguarded division                                                                                                                                                                                                                                        |
| `perpFunding` NaN via negative base to fractional power                                                       | **Confirmed** — `carry.ts:92`                                                                                                                                                                                                                                                           |
| `option.call` defaults `style: 'european'`                                                                    | **Confirmed** — `contract.ts:22`                                                                                                                                                                                                                                                        |
| Options backtest hard-codes `rate ?? 0.04` across all history                                                 | **Confirmed** — `backtest/options/engine.ts:219`                                                                                                                                                                                                                                        |
| Umbrella exposes `technical_analysis.ta`, `performance.performance`, `backtest.backtest`, `strategy.strategy` | **Confirmed** — eponymous const exports (e.g. `ta/index.ts:1100`) doubled by the umbrella's `export * as`                                                                                                                                                                               |
| Exotics use positional discriminators                                                                         | **Confirmed** — `exotics.ts:199, 1389, 1719`                                                                                                                                                                                                                                            |
| Bachelier `vol` is price-units normal vol under the same field name as BSM's fractional `vol`                 | **Confirmed** — `bachelier.ts:35-36`                                                                                                                                                                                                                                                    |
| MCP input budget counts UTF-16 code units, not bytes                                                          | **Confirmed** — `server.ts:177`                                                                                                                                                                                                                                                         |
| `estimateCovariance` SPD-postcondition counterexamples (constant series; collinear single-index)              | Code-consistent; not independently re-run, but the described paths exist and repro is claimed against `490ee0c1` — accepted                                                                                                                                                             |

### 10.2 Conceded and adopted from the companion (new findings F36–F42)

- **F36. `option.call` defaulting to European exercise is an unsafe default** — the flagship pro example (`underlying: 'AAPL'`) silently builds the wrong exercise style for a US equity option; American puts are worth more. This review claimed to cover "sensible defaults" and missed it. Adopt: require `style` in the generic builder now (cheap); instrument builders (`usEquityCall`) as the lovable layer next.
- **F37. The Bachelier unit collision.** §3 of this review praised "one vocabulary — `vol` everywhere, lint-enforced" as a strength. The companion is right that this uniformity papers over a unit change (dimensionless in BSM, price units in Bachelier; both positive numbers) — the classic silent-wrong-number setup, actively _enforced_ by the lint rule. Adopt `normalVol` for Bachelier surfaces. This is a genuine correction to this review's judgment, not just an addition.
- **F38. Non-finite success states.** This review probed garbage inputs; the companion probed valid-but-extreme inputs producing NaN/Infinity with `converged: true` (F-lambda, perpFunding, covariance SPD). Different probe axis, real class of honesty violations. Adopt its `assertFiniteResult`-style postcondition at explained/pro boundaries, the SPD fallback/floor + explicit market-proxy disclosure, and adaptive finite-difference bumps.
- **F39. Engine substitutability.** Honor or remove `greeks: false` everywhere; adopt the capability-metadata idea and the parameterized engine contract suite (which would have caught the BSM/Black-76 divergence mechanically).
- **F40. Topology duplications.** Fix `technical_analysis.ta`/`performance.performance`/`backtest.backtest`/`strategy.strategy`; add symmetrical umbrella domain subpaths (with the F44 carve-out below).
- **F41. Exotics positional discriminators.** `digital.price(type, kind, input)` et al. are a third grammar on the high-level surface; move to single-object inputs with discriminated unions, keep positional forms kernel-only.
- **F42. The public-surface manifest + conformance gate.** The best structural idea in either document. This review hand-found 35 inconsistencies; the manifest (classify every export as facade/analysis/artifact/kernel, then _generate_ exports maps, API reports, first-touch fixtures, doc indices, and MCP registration from it) is the machine that prevents the next 35. Adopt wholesale — it is the permanent form of F11/F15/F16/F22.

### 10.3 The companion's blind spots (where this review's findings still carry)

- It cites the garbage sweep's "empty crash ledger" without locating the sweep's **class-method blind spot** — F4 (`Position.payoff()` raw TypeError) is a live counterexample on the same head.
- It misses the worst silent-wrong-number in the library: **F3**, `technical_analysis.rsi(closes, 7)` silently computing RSI-14 — squarely an API-surface issue inside its scope.
- By deferring "documentation," it defers **F1/F2** (NaN quickstart; crashing strategies guide) — see §10.4.6 for why that ordering is wrong.
- Its MCP section is architectural ("generate from the manifest later") and misses the concrete tool-level failures an agent hits **today**: date-blind `option.price` (F7), the 19-vs-20 and seed-default drift (F8), the description-less IV schema (F9).
- It gestures at "builders remain permissive" where this review has the specific verified instances (F6 `longCall({quantity:-1})`, F5 `crossOverSeries`, F17 bar keys, F12 `iv` vs `vol`, F15 code-registry leaks, F18 covariance unreachable from risk).

### 10.4 Where the documents genuinely disagree — the decisions to make

These are philosophy calls, not fact disputes. Each entry states both positions and this review's recommendation.

**10.4.1 Scoring: what does the number measure?**
The companion scores 7/10, treating API coherence (5.5) as a multiplier over everything; this review scored ~8.5 by weighting the paths users actually walk (facades, errors, explain, TA, strategy), which are already extraordinary. Both are defensible measurements of different things — maintainer's-eye taxonomy vs user's-eye experience. Reconciled honestly: **~7.5–8 today**, and the number matters less than the shared conclusion: both documents agree precisely on what closes the gap, and neither thinks it is feature breadth.

**10.4.2 Umbrella root: namespace-only vs curated flagship hoist.**
The companion wants the umbrella root namespace-only (`q.options.price(...)`); its own five-minute path gives up `import { bs } from 'totalfinance'` — the best first line in the library. This review's position: the flat root is broken **as an unbounded re-export** (94 exports, kernels and constants included — F16), not as a concept. **Recommendation: keep a _curated_ flagship hoist (`bs`, `black76`, `bachelier`, `option`, `market`, `engines`, `iv` suite), evict kernels/constants/schemas to subpaths, add the symmetrical domain subpaths the companion proposes.** Deliberate asymmetry in favor of the flagship is a feature; accidental asymmetry is the bug.

**10.4.3 Vocabulary: verbose renames vs compact facade grammar.**
The companion recommends `volatility`/`riskFreeRate` at the high level and demoting `t` to kernels. This review disagrees for the compact facades: `vol`, `rate`, `t` are half of why `bs.call({...})` beats py*vollib — terse, universally read by practitioners, documented in hover types. The \_real* defect in the current vocabulary is the Bachelier unit collision (F37), which `normalVol` fixes surgically without verbose-ifying the facades. **Recommendation: keep `vol`/`rate`/`t` in facades; adopt `normalVol`; reserve long names for the pro tier only if the manifest wants them; `expiresAt`-style exact instants on contracts per the companion.**

**10.4.4 Module format: dual ESM/CJS vs ESM-only.**
The companion says "strongly consider dual exports." Disagree — using its own evidence: it correctly notes Node 18/20 are EOL and 22/24 are LTS, and every supported LTS line handles `require(ESM)`. Adding the `"default"` export condition (F10) delivers `require()` consumers on all supported runtimes with zero dual-build maintenance and zero dual-package hazard. **Recommendation: ESM-only + `default` condition + an explicit compatibility note. No dual build.**

**10.4.5 MCP: "small and somewhat arbitrary subset."**
Unfair characterization. Twenty tools across eight families with discovery companions (`technical_analysis.list`/`technical_analysis.describe`, `strategy.list`) is deliberate, well-judged granularity — the alternative (335 indicator tools, 58 strategy tools) is worse for agents. The _coverage_ point (no crypto/FI/advanced-vol tools yet) is fair and F34 already tracks it. **Recommendation: keep the curated-registry philosophy; grow it from the manifest allowlist; do not read "generate from manifest" as "expose everything."**

**10.4.6 P0 ordering: API-coherence-first vs trust-breakers-first.**
The companion's P0 is entirely the API-coherence pass; docs and first-run are deferred to the end. If this branch publishes on anything like its current cadence, that ordering ships a NaN quickstart (F1), a crashing guide example (F2), and a silent RSI miscompute (F3) to the first hundred visitors — each an ~hour fix. Cheapness × trust-damage dominates: **first impressions are not "documentation," they are the product's opening move.** Recommendation: the §10.5 merged list — landmines this week, correctness-of-success next, the coherence pass before 1.0.

### 10.5 Reconciled priority (the merged list)

1. **Trust-breakers, immediately** (this review): F1 NaN quickstart, F2 crashing guide, F3 rsi params guard, F4 Position guards + ratchet-to-methods, F5 crossOverSeries example + `latchSeries`, F6 quantity check, F7 MCP date acceptance, F8/F9 MCP drift + IV schema.
2. **Correctness of success states** (companion): F38 postconditions (lambda, perpFunding, covariance SPD + proxy disclosure, FD bumps), F39 `greeks: false` + engine contract suite.
3. **The API-coherence pass, pre-1.0** (both; companion's mechanism): F42 manifest + conformance gate; F11 one result grammar (vol/structure/crypto migration); F16+F40 topology (curated hoist, kernels to `/kernel`, domain subpaths, de-dupe `technical_analysis.ta`); F36 require `style` (+ instrument builders); F37 `normalVol`; F41 exotics object inputs; F12–F15 renames and code-registry hygiene.
4. **Packaging/launch** (this review): F10 — `default` condition, repo URLs, changesets fixed group, generated counts. No dual CJS.

**Cross-review bottom line:** the companion is the better _architecture_ review; this one is the better _experience_ review. Its manifest + conformance gate should become the spine that carries both documents' findings; the disagreements above are settled here as: curated hoist over namespace-purity, compact facade vocabulary over verbose renames (plus `normalVol`), ESM-only + `default` over dual builds, curated MCP registry over generated-everything, and landmines-first over coherence-first ordering.

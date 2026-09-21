# Gate B — the shared artifact spine

Status: DESIGN ACCEPTED-FOR-REVIEW + FIRST-SLICE CONTRACTS IMPLEMENTED (2026-08-19). The first
slice — canonical JSON, content hash, migration registry, market snapshot, analysis artifact,
table handle, scenario set — is code with tests at `packages/core/src/artifacts/` and
`packages/core/test/artifacts-*.test.ts`. Runners, storage, domain mappers, and manifest/api-report
registration are explicitly later slices.

This document is the Gate B decision record required by the
[platform completeness roadmap](../platform-completeness-roadmap.md) ("Gate B — define the shared
artifact spine") and [implementation-order §4.2](../implementation-order.md). Every decision below
states its rationale and the alternative it rejected, because Gate B is the one gate whose
mistakes are permanent: books (Gate D), extension contracts (Gate C), data providers (Gate E), MCP
handles (Gate F), and cross-language clients (Gate G) all inherit these containers.

## What Gate B is, in one paragraph

Compute already returns honest results (Law 2 grammars, `Computed`, assumptions, diagnostics).
What TotalFinance lacks is ONE grammar for the things layers above compute want to **save, share, and
replay**: the market state a calculation read, the identity of a result, the definition of a
scenario, and the serialized bytes and hashes that make all three durable. Without the spine, each
future package invents an incompatible container — the exact failure the roadmap names ("books,
data, MCP handles, workers, cross-language calls, and saved research otherwise invent incompatible
containers"). The spine is containers only: it never fetches, never reads the clock, never touches
storage (law #7), and nothing above forces it on a direct call (`blackScholes.call({...})` is
untouched — law #5).

---

## Decision 1 — package placement: `@totalfinance/core/artifacts`, a separate core entrypoint

**Decision.** The spine lives in `@totalfinance/core` as a NEW subpath entrypoint
`@totalfinance/core/artifacts` (`packages/core/src/artifacts/`), exactly parallel to
`@totalfinance/core/schema`. It is NOT re-exported from core's root index.

**Rationale.**

- **Graph position.** Core is the bottom of the dependency DAG; every compute, composition, and
  future data/workflow package already depends on it. The spine becomes importable everywhere with
  ZERO new edges, so `tools/package-graph.test.ts` (the FC0 ownership matrix, the tier law, the
  data-edge law) is untouched — no allowed-edges row needs rewriting, and no future package can be
  forced into an upward edge to reach its own serialization grammar.
- **Ownership precedent.** Core already owns every cross-domain grammar the spine composes with:
  `Computed`, `Assumptions`/`CONVENTIONS_VERSION`, `Provenance`, `Diagnostics`, the canonical
  market-data payload types (`RateCurve`, `OptionQuote`, `Bar`), the one `asOf` time grammar
  (`resolveAsOf`), and the runtime schema facade. A snapshot that reuses `RateCurve` verbatim
  belongs next to `RateCurve`.
- **Hot-path rule.** `@totalfinance/core/schema` exists as a separate entrypoint so validator code
  stays out of compute bundles (spec §6); serialization + SHA-256 machinery deserves the identical
  treatment. Because the root index does not re-export the spine, every existing bundle budget in
  `tools/bundle-size/budgets.ts` (including the forbidden-needle checks on
  `@totalfinance/options/black-scholes`) measures byte-for-byte what it measured before this change.

**Rejected: a new `@totalfinance/artifacts` package.** It buys no isolation (the spine has zero heavy
deps) and costs real structure: a new workspace package cannot even pass
`tools/package-graph.test.ts` without a manifest tier file — which the serial landing owns, not
this slice — plus the seven registration points every new package drags (tsconfig ×2, api-report
×2, umbrella ×3, vitest alias, garbage-sweep). Splitting later remains cheap (the module is
self-contained behind one entrypoint); merging a package back into core later is not.

**Rejected: placement in `risk`/`backtest`/`strategy`.** Any domain package is a sibling of the
other domains; the spine must be BELOW all of them or half the library reaches it only through an
illegal edge.

**Rejected: the umbrella (`totalfinance`).** The umbrella is the top of the graph; nothing may depend
on it.

**Wiring done in this slice** (the only wiring this slice is allowed): core `package.json` exports
`"./artifacts"`, root `vitest.config.ts` alias `@totalfinance/core/artifacts`. The root `tsconfig.json`
wildcard `@totalfinance/core/*` already resolves the new directory. Deliberately NOT done here, owned
by the serial landing: manifest classification of the new exports (Manifest Law 1 — hand-curated
in `tools/manifest/packages/core.json`, never `manifest:update`), api-report regeneration, umbrella
exposure, generated docs, and a bundle budget for the new entrypoint.

---

## Decision 2 — canonical JSON: one serialized form, versioned rules

**Decision.** Every spine identity hashes the value's **canonical JSON**
(`canonicalJsonOf(value)`), governed by `CANONICAL_JSON_VERSION = 1`:

1. object keys sort by UTF-16 code unit at every depth; `undefined` members are omitted;
2. numbers print via `JSON.stringify` — the ES2020 shortest-round-trip decimal form, which is
   spec-deterministic across engines — with `-0` folded to `0` (JSON cannot carry the sign bit;
   the fold is the ONE disclosed loss, and it is tested);
3. non-finite numbers encode as the library-wide wrapper `{ "nonFinite": "NaN" | "Infinity" |
"-Infinity" }` — byte-identical to the encoding `@totalfinance/technical-analysis` already stamps
   into stream snapshots (its `SCHEMA_VERSION` 3 rationale: `JSON.stringify(NaN)` is `null`, and a
   `null` in a numeric slot reads as `0` downstream). **Reused, not diverged**: a TA state nested
   inside a saved artifact round-trips losslessly through one grammar. One deliberate divergence
   in ENFORCEMENT, not encoding: the spine serializer REFUSES caller data that literally wears the
   wrapper shape (`{ nonFinite: 'NaN' }` as an ordinary field), because at this boundary the input
   is caller data and the reservation is enforceable — TA's state trees are opaque and can only
   document it;
4. strings escape per well-formed `JSON.stringify` (ES2019 lone-surrogate escaping — spec-fixed
   bytes);
5. everything else — `Date`, `Map`, `Set`, typed arrays, class instances, `bigint`, functions,
   `undefined` INSIDE an array — is refused with a teaching error naming the path
   (`serialization.unsupported_value`). `toJSON` methods are deliberately not invoked: a hash that
   depends on hidden prototype behavior is not reproducible from the data. A `Date` error teaches
   `EpochMs`; a typed-array error teaches that Arrow is reserved (Decision 7).

`fromCanonicalJson(text)` is the exact inverse (wrapper → number), and
`canonicalJsonOf(fromCanonicalJson(text)) === text` for canonical text.

**Rejected: hash `JSON.stringify` output.** Key order is insertion order — two logically equal
values built in different field orders would be "different", breaking dedup and replay comparison
at the first refactor that reorders object literals.

**Rejected: RFC 8785 (JCS).** JCS is the closest external standard, but it forbids non-finite
values outright (it inherits JSON's number model), and TotalFinance's finite-success law has RATIFIED
disclosed-NaN exceptions (TA warmup slots) that saved artifacts must round-trip. Adopting JCS
would have made the one thing the library most needs to persist unrepresentable. The spine keeps
JCS's useful properties (sorted keys, shortest-form numbers) and documents the divergence here.

**Rejected: silently coercing unsupported values** (Dates to ISO strings, Maps to objects,
`undefined[1]` to `null` as `JSON.stringify` does). Every coercion is a guess baked permanently
into a hash; a pricing library's serializer refuses rather than guesses.

## Decision 3 — content hash: pure-TypeScript SHA-256, algorithm-prefixed

**Decision.** `contentHash(value)` = `'sha256:' + sha256Hex(canonicalJsonOf(value))`, lowercase
hex, with SHA-256 implemented in ~60 lines of dependency-free TypeScript (FIPS 180-4) over the
canonical UTF-8 bytes (hand-rolled UTF-8: the ES2022 compile target has no `TextEncoder` lib type,
and the hand encoder pins the byte contract — lone surrogates encode as U+FFFD, matching
`TextEncoder`). The `sha256:` prefix makes any future algorithm change a visible new prefix, never
a silent re-keying.

**Rationale.** A content hash is an identity: dedup keys, replay comparison, and `createdFrom`
lineage chains all assume two different artifacts never share a hash — so it must be
collision-resistant, which is also the repo's existing convention (every tooling hash in
`tools/manifest/*` is SHA-256). And it must be synchronous and browser-safe: `node:crypto` is
Node-only (today it appears exclusively under `tools/`, never in a package), and
`crypto.subtle.digest` is async — an awaitable `create*` constructor would poison the whole spine
with promises to hash a few hundred bytes. Envelopes are SMALL BY DESIGN (large tables travel by
handle, Decision 5), so a pure-TS hash is comfortably fast where it is actually used; the
implementation is pinned to FIPS test vectors, a two-block vector, the million-`a` vector, and
Python-computed UTF-8 goldens.

**Rejected: FNV-1a / xxHash** (fast, but identity by collision-resistance is the whole point);
**crypto.subtle** (async, and unavailable in some non-secure contexts); **node:crypto** (breaks
browser safety, violating the package's own layering); **a hashing dependency** (core has zero
runtime deps; this does not change that).

### What each hash covers

| Identity                    | Covers                                                                                                                                            | Excludes                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `marketSnapshotContentHash` | `kind`, `schemaVersion`, `asOf`, `conventions` (incl. `conventionsVersion`), `observations`                                                       | `provenance`               |
| `AnalysisArtifact.id`       | `kind`, `schemaVersion`, `artifactType`, `producedBy` (incl. `libraryVersion`), `conventionsVersion`, `inputs`, `createdFrom`, `result`, `tables` | `id` itself, `provenance`  |
| `ArtifactInputs.inputsHash` | `{ snapshotHash?, parameters? }`                                                                                                                  | everything else            |
| `scenarioSetContentHash`    | `kind`, `schemaVersion`, `name`, `scenarios`                                                                                                      | `provenance`               |
| `TableHandle.contentHash`   | the table's canonical JSON row projection                                                                                                         | locator, mediaType, counts |

**Provenance is outside every identity — decided, not accidental.** Two snapshots carrying
identical numbers from two vendors are the SAME market: dedup should merge them and replay should
compare them equal. Conventions are INSIDE identity for the mirror-image reason: two snapshots
differing only in day count produce different numbers and must never collide. _Rejected
alternative:_ hash-everything (re-labeled identical data becomes "different", quietly defeating
dedup) and hash-values-only (a conventions change silently collides two economically different
states — the worse failure). `producedBy.libraryVersion` is covered when present: an artifact
records WHO computed it, and two library versions may legitimately disagree within tolerance;
callers who want version-independent identity omit the optional field — explicitly.

### Stability guarantees

- Same logical value → same hash, forever, per (`CANONICAL_JSON_VERSION`, envelope
  `schemaVersion`, `sha256:` prefix) triple. All three are source-controlled constants; none can
  change silently.
- Hashes are portable across JS engines (shortest-round-trip number printing and JSON string
  escaping are ECMA-262-fixed) and across languages (the canonical bytes are plain UTF-8 JSON — a
  Python or Rust client reimplements ~40 lines of canonicalization, not a bespoke binary format).

## Decision 4 — the versioned market snapshot

**Decision.** One envelope, `MarketSnapshot` (`kind: 'totalfinance.market-snapshot'`,
`MARKET_SNAPSHOT_SCHEMA_VERSION = 1`):

```ts
interface MarketSnapshot {
  kind: 'totalfinance.market-snapshot';
  schemaVersion: number;
  asOf: EpochMs; // resolved ONCE via core resolveAsOf — never the machine clock
  conventions: {
    conventionsVersion: string; // stamped by the library, not caller-settable
    dayCount?: DayCount; // REQUIRED when flat riskFreeRates are present
    compounding?: InterestCompounding; // REQUIRED when flat riskFreeRates are present
    calendar?: string;
  };
  observations: {
    spots?: Record<SymbolId, SpotObservation>; // { price, currency?, timestampMs? }, open
    riskFreeRates?: Record<string /*currency*/, number>; // flat annual decimals, envelope conventions
    dividendYields?: Record<SymbolId, number>;
    volatilities?: Record<SymbolId, number>; // flat annualized decimals, ≥ 0
    curves?: Record<string /*label*/, RateCurve>; // core RateCurve VERBATIM — own conventions
    surfaces?: Record<SymbolId, VolatilitySurfaceObservation>; // rectangular IV grid
    chains?: Record<SymbolId, OptionChainObservation>; // inline OptionQuote rows XOR a TableHandle
  };
  provenance?: Provenance; // caller-supplied, never fetched (law #7); outside the hash
}
```

Constructors: `createMarketSnapshot({ asOf, conventions?, observations, provenance? })` validates,
resolves `asOf`, stamps `kind`/`schemaVersion`/`conventionsVersion`, and returns a deeply frozen
canonical copy (later mutation of the caller's input cannot reach it).
`readMarketSnapshot({ snapshot, migrations? })` is the one door back in: closed envelope key set,
kind check, version gate, explicit migration, full body re-validation, frozen canonical copy, and
a `migrationsApplied` report.

**Key semantic decisions.**

- **Observations refuse non-finite numbers — globally, decoration included.** An unobservable
  quantity is ABSENT, never `NaN` (the finite-success law applied to inputs). Consequence: a
  snapshot's stored form is pure JSON with no wrappers, so `JSON.stringify(snapshot)` is lossless
  as-is. _Rejected:_ tolerate-and-encode (TA must, because NaN arises in its own arithmetic from
  valid input; a market OBSERVATION has no such excuse, and a tolerated NaN is an unenforceable
  contract).
- **Flat rates demand their conventions.** `riskFreeRates` without `conventions.compounding` and
  `conventions.dayCount` is refused with a teaching error — no silent economics. Curves are exempt
  because `RateCurve` states its own.
- **Reuse of core market-data vocabulary — validated as such.** Curve observations ARE `RateCurve`
  and are validated by core's ONE shared curve-data validator (real ascending `'YYYY-MM-DD'`
  pillar dates via the core date parser, finite values, stated conventions, string
  `interpolation`) — the same validator the Gate C `discountCurve` observation uses; chain rows
  ARE `OptionQuote`-shaped open records whose consumed numeric fields must be finite numbers when
  present (a wrong-typed `bid: 'oops'` refuses with the row index; vendor decoration is
  preserved). This is what makes existing per-domain market objects map IN
  without breaking them: options' `market({ spot, riskFreeRate, volatility, dividendYield, asOf })`
  is one spot + one flat rate + one flat vol + one flat yield; an FI curve drops in unchanged; a
  chain's rows drop in unchanged. Domain packages keep their own market builders permanently (the
  API-posture rule of roadmap Program 1); convenience mappers (`marketSnapshotFrom(optionMarket)`,
  a snapshot→`OptionMarket` projection) are a LATER slice that must live where both vocabularies
  are visible — they are one-liners over this grammar, deliberately not designed twice here.
- **Envelope closed, entries open (Law 12).** Top level, `conventions`, `provenance`, surface
  grids, and chain containers are closed (a misspelled section must be heard); spot/quote entries
  are open structural artifacts — validated where consumed, vendor decoration preserved (finite).
- **Sign policy from the real world.** Spot prices are finite, sign-unconstrained (April 2020 WTI
  settled negative); volatilities are `≥ 0`; discount factors `> 0`; surface strikes `> 0`,
  expiries `≥ 0`. No-arbitrage surface checks belong to `@totalfinance/volatility` (no second engine),
  not the container.

**Rejected: a rich `Market` class with methods** (discount(), forward()): the snapshot is DATA;
behavior stays in domain packages, or the serializable boundary law dies immediately.
**Rejected: per-domain snapshot envelopes** (an options snapshot, an FI snapshot): the seam the
platform needs is exactly the JOINT state — a book values equities off `spots`, options off
`chains`/`surfaces`, and bonds off `curves` from ONE instant. **Rejected: requiring the snapshot
anywhere.** Direct named-scalar calls remain the front door for one-off calculations.

## Decision 5 — the analysis artifact and large-table references

**Decision.** `AnalysisArtifact` (`kind: 'totalfinance.analysis-artifact'`,
`ANALYSIS_ARTIFACT_SCHEMA_VERSION = 1`):

```ts
interface AnalysisArtifact {
  kind: 'totalfinance.analysis-artifact';
  schemaVersion: number;
  id: string; // contentHash of the body (everything but id + provenance) — stamped
  artifactType: string; // dot-namespaced result-schema name, e.g. 'structure.gamma-exposure'
  producedBy: { operation: string; libraryVersion?: string };
  conventionsVersion: string; // LIBRARY-stamped at creation from CONVENTIONS_VERSION — the snapshot's law
  inputs: { inputsHash: string; snapshotHash?: string; parameters?: unknown };
  createdFrom?: string[]; // parent artifact ids — the provenance chain
  result: Record<string, unknown>; // the producing call's return value, VERBATIM
  tables?: Record<string, TableHandle>;
  provenance?: Provenance;
}
```

- **`result` is saved verbatim, floor-checked at the TRUE Law-2 floor** — `result.assumptions` a
  plain object and `result.diagnostics.warnings` an array — which both the envelope grammar and
  the report grammar already satisfy, INCLUDING real reports whose assumptions carry no
  `conventionsVersion` field (DCF, event study, time-weighted return; when a result does carry
  `assumptions.conventionsVersion` it rides along verbatim inside `result`). A bare facade number
  is refused with the teaching to save its `.explain()` result. Saving never rewrites the result:
  replay compares saved-vs-recomputed byte-for-byte, which only works if save is the identity.
  Disclosed non-finite values in results (TA warmup, documented kernel IEEE behavior) round-trip
  through the wrapper; the artifact does not re-litigate the producing call's finiteness laws.
- **The top-level `conventionsVersion` is LIBRARY-STAMPED at creation** from core's
  `CONVENTIONS_VERSION`, exactly as `createMarketSnapshot` stamps its envelope — one law. It is
  never an echo of the result and never caller-set; a stored artifact's stamp is validated as a
  non-empty string and is covered by the id.
- **`readAnalysisArtifact` VERIFIES both hashes** — `inputs.inputsHash` is recomputed from the
  stored `{ snapshotHash, parameters }` and a mismatch is refused (a forged inputs section fails
  even inside an outer-consistent envelope), and the body hash is recomputed against the stored
  `id` (`artifact.id_mismatch`) with the teaching that an intentional edit is a NEW artifact with
  `createdFrom: [oldId]`. Tampering (including lossy persistence through plain `JSON.stringify` of
  a NaN-bearing result — persist artifacts with `canonicalJsonOf`) is caught structurally.
- **`TableHandle`** (`kind: 'totalfinance.table-handle'`): `contentHash` + `rowCount` + `columnCount`
  - optional `columns`, `locator`, `mediaType`. The locator is an OPAQUE string — the spine owns
    no storage; the hash is what makes the reference verifiable wherever the bytes live. Handles
    appear in artifacts (`tables`) and in snapshots (large chains), so envelopes stay small enough
    to hash, store, diff, and hand to an agent (Journey 3: no large chain travels through an LLM
    context). Every site that accepts a stored handle applies the ONE full validator
    (`columns.length === columnCount` when present, `locator` a non-empty string, `mediaType` a
    string) — the cheap structural predicate is never a validation door.

**Rejected: inlining tables with a size threshold** (a hash-visible behavior cliff at an arbitrary
byte count); **a storage interface in core** (`save()`/`load()` — the data plane is Gate E's, and
law #7 keeps effects out of compute); **auto-capturing `producedBy` from stack/package
introspection** (hidden process state in an identity — the caller states what ran);
**UUID/timestamp ids** (they identify nothing — the content hash IS the dedup and replay key, and
`readAnalysisArtifact` could never verify a random id).

## Decision 6 — scenario sets: data, not a DSL

**Decision.** `ScenarioSet` (`kind: 'totalfinance.scenario-set'`, `SCENARIO_SET_SCHEMA_VERSION = 1`):
named `ScenarioDefinition`s, each `{ name, shocks, overrides? }`, where a shock is
`{ factor, kind: 'percent' | 'absolute', value, target? }` and an override is
`{ factor, value, target? }`.

- **The shock triple is `@totalfinance/risk`'s existing `Shock` grammar verbatim** (`factor`/`kind`/
  `value`, same factor vocabulary `spot | volatility | riskFreeRate | time | dividend | custom`),
  extended by optional `target` for multi-asset scenarios. A spine shock without `target` IS a
  risk `Shock` — Gate D's runner hands these to the existing Taylor/reprice engine unchanged. Core
  cannot import risk (layering), so the spine DEFINES the grammar and risk's runtime type remains
  structurally identical; a compile-time parity assertion belongs to the Gate D slice that touches
  risk.
- **Semantics fixed now** so every future runner agrees: overrides apply first (absolute sets),
  then shocks in array order (deterministic composition); duplicate `(factor, target)` overrides
  in one scenario are a refused CONFLICT (the second absolute set would silently win); repeated
  shocks are legal and compose in order; scenario names are unique within a set (they are the
  result-cube's row identity).
- **No DSL.** No expressions, no conditionals, no cross-references, no relative dates. Anything a
  list of typed records cannot express uses the escape hatch a runner must accept (a caller
  reprice function) — per the roadmap's "without inventing a DSL beyond data" and the Program 4
  posture. _Rejected:_ a shock-expression language (unbounded surface, unauditable hashes);
  baking historical event libraries into the container (they are DATA that ships as scenario sets
  with provenance, "not hard-coded truth in compute").

What Gate B deliberately does NOT decide: how a runner maps `factor`+`target` onto snapshot
observation paths for full revaluation, approximation-mode labeling, and result-cube shape — those
are Gate D's contracts, and freezing them here without the runner would be design without
evidence. The container grammar above is sufficient for Gate D to build against.

## Decision 7 — versioning, migration, and replay policy

**Decision.** Every envelope carries integer `schemaVersion` with one shared reader policy
(implemented once in `createArtifactMigrationRegistry` and used by all three readers):

- **same version** → restore directly (and reading a current envelope applies zero migrations —
  idempotence is a tested law);
- **newer** → refuse (`snapshot.unsupported_version`): this build cannot know what changed, and
  restoring blind is silent corruption (the TA reader's law, spine-wide);
- **older** → restore ONLY through explicitly registered single-step migrations
  (`fromVersion → fromVersion + 1`, each with a required human `description`), applied in order;
  the first missing link refuses (`artifact.migration_missing`); every applied step is echoed in
  `migrationsApplied`. A migration that fails to stamp its declared version is convicted
  (`snapshot.invalid_version`). Duplicate registration for one `(kind, fromVersion)` is refused
  (`artifact.duplicate_migration`).
- The registry is an ARGUMENT to readers — never module-global state (a hidden process-wide
  registry is exactly the "result depends on hidden process state" failure Program 11's exit gate
  forbids).

**Rejected:** silent auto-upgrade (an unreviewable rewrite of stored data); "best-effort" partial
migration (a corrupt envelope wearing a plausible version); retaining legacy parsers per version
(pre-1.0, D5/N9: corrections are clean — the TA precedent).

**What replay promises** (and is tested to): given an envelope and access to its referenced data,

1. `read*` restores a value deep-equal to what `create*` returned, with equal content hash
   (round-trip stability);
2. an artifact names its operation, inputs (by hash), conventions, and lineage precisely enough to
   re-issue the producing call and compare results byte-for-byte via the same canonical form;
3. nothing in restore consults ambient state — no clock, no locale, no globals — so replay is
   deterministic across process, machine, and (by the canonical-bytes contract) language.

What replay does NOT promise: that TotalFinance re-executes anything (the spine has no runner), or
that two LIBRARY VERSIONS agree numerically — that is the semantic-parity law's tolerance regime,
and the artifact records `libraryVersion` so a comparison knows what it is comparing.

## Decision 8 — JSON-safe first; Arrow reserved, not implemented

**Decision.** Every spine value has exactly one canonical JSON form now. A lossless Apache Arrow
mapping is a RESERVED contract, stated here so nothing later forecloses it:

- the reserved media type is exported as `TABLE_MEDIA_TYPE_ARROW_RESERVED`
  (`application/vnd.apache.arrow.file`) so no caller invents a second name;
- an Arrow-encoded table's `TableHandle.contentHash` is defined as the hash of the SAME canonical
  JSON row projection — one logical table, one identity, in either encoding;
- non-finite values need no wrapper in Arrow (IEEE-754 columns carry them natively); the wrapper
  is a JSON-boundary encoding, not a data model.

Implementation triggers only on a MEASURED large-table consumer (a benchmarked chain/backtest
workload where JSON row cost is the bottleneck) — per this repo's standing user decision that
performance work (benchmarks/WASM/SIMD/Arrow, roadmap §1.4 and Gate G) is deferred and must not
start ambiently. _Rejected:_ implementing the Arrow path now (performance work without a measured
consumer, against an explicit user decision); designing the spine Arrow-first (Arrow is the wrong
shape for small heterogeneous envelopes, which are the 99% case).

---

## Worked end-to-end example: snapshot → analysis → saved artifact → replay

```ts
import {
  createMarketSnapshot,
  marketSnapshotContentHash,
  readMarketSnapshot,
  createAnalysisArtifact,
  readAnalysisArtifact,
  createTableHandle,
  createScenarioSet,
  canonicalJsonOf,
  fromCanonicalJson,
  contentHash,
} from '@totalfinance/core/artifacts';

// 1. Freeze the market you observed (caller supplies data AND its origin — nothing is fetched).
const snapshot = createMarketSnapshot({
  asOf: '2026-07-20',
  conventions: { dayCount: 'ACT/365F', compounding: 'continuous' },
  observations: {
    spots: { AAPL: { price: 195.3, currency: 'USD' } },
    riskFreeRates: { USD: 0.045 },
    volatilities: { AAPL: 0.24 },
    dividendYields: { AAPL: 0.005 },
  },
  provenance: { provider: 'insiderfinance', dataset: 'eod', asOf: 1784505600000 },
});
const snapshotHash = marketSnapshotContentHash(snapshot); // 'sha256:…' — provenance excluded

// 2. Run ANY existing analysis exactly as today — the spine changes nothing about compute.
//    (Illustrative: any Law-2 result works verbatim.)
const report = gammaExposure({ chain: rows, spot: 195.3 /* … */ }); // { …, assumptions, diagnostics }

// 3. Save it: identity, inputs, lineage, and the big per-strike table BY REFERENCE.
const profileRows = report.profile; // large table — lives in storage, not in the envelope
const artifact = createAnalysisArtifact({
  artifactType: 'structure.gamma-exposure',
  producedBy: { operation: 'gammaExposure', libraryVersion: '0.0.1' },
  inputs: { snapshotHash, parameters: { minOpenInterest: 100 } },
  result: report,
  tables: {
    profile: createTableHandle({
      contentHash: contentHash(profileRows),
      rowCount: profileRows.length,
      columnCount: 2,
      columns: ['strike', 'gammaExposure'],
      locator: 'artifacts/gex/aapl-2026-07-20.json', // meaningful to YOUR storage, not to the spine
    }),
  },
});

// 4. Persist with the canonical serializer (lossless for disclosed non-finite results).
write('artifacts/gex/latest.json', canonicalJsonOf(artifact));
write('snapshots/2026-07-20.json', JSON.stringify(snapshot)); // snapshots are wrapper-free JSON

// 5. Replay, days later, anywhere: restore is validated, verified, and reported.
const { snapshot: sameMarket } = readMarketSnapshot({
  snapshot: JSON.parse(read('snapshots/2026-07-20.json')),
});
const { artifact: saved } = readAnalysisArtifact({
  artifact: fromCanonicalJson(read('artifacts/gex/latest.json')),
});
// saved.id was RECOMPUTED and matched — an edited file would have been refused.
const recomputed = gammaExposure({
  /* rebuilt from sameMarket + saved.inputs.parameters */
});
canonicalJsonOf(recomputed) === canonicalJsonOf(saved.result); // replay comparison, byte-exact

// 6. Name the stress you'll run across domains later (Gate D executes; Gate B only represents).
const stress = createScenarioSet({
  name: 'q3-desk-stress',
  scenarios: [
    {
      name: 'crash -20%',
      shocks: [
        { factor: 'spot', kind: 'percent', value: -0.2 },
        { factor: 'volatility', kind: 'absolute', value: 0.15 },
      ],
    },
    { name: 'rates 2019', shocks: [], overrides: [{ factor: 'riskFreeRate', value: 0.0155 }] },
  ],
});
```

---

## Acceptance laws

Checked boxes are implemented and green in this slice
(`packages/core/test/artifacts-canonical.test.ts`, 18 tests;
`packages/core/test/artifacts-envelopes.test.ts`, 35 tests). Unchecked boxes belong to named later
slices. Tolerances: hashing and round-trip laws are EXACT (byte/`Object.is` equality — hashing has
no epsilon); nothing in the spine performs floating-point arithmetic on market values.

- [x] **Hash round-trip stability (exact).** `create* → JSON → read*` restores a deep-equal
      envelope with an identical content hash; canonical text is a fixed point
      (`canonicalJsonOf(fromCanonicalJson(t)) === t`); key order never changes a hash; `-0` and
      `0` share one hash.
- [x] **Golden pinning (exact).** `sha256Hex` matches FIPS 180-4 vectors ('', 'abc', two-block,
      million-`a`) and Python-hashlib UTF-8 goldens; `contentHash` matches independently computed
      digests of hand-written canonical strings.
- [x] **Sensitivity (exact).** Any covered field change — value, nested value, array element,
      array ORDER, added member — changes the hash; provenance changes never do.
- [x] **Non-finite round-trip (exact).** NaN/±Infinity in a saved RESULT survive
      `canonicalJsonOf`/`fromCanonicalJson` bit-honestly (NaN reads back as NaN, signs of
      infinities preserved); snapshots REFUSE non-finite observations, decoration included; the
      reserved wrapper shape is refused as caller data.
- [x] **Migration policy.** A newer version refuses with a teaching error; an older version
      refuses without a registered migration; a registered chain applies in single steps, in
      order, each step reported; a step that skips versions or double-registers is refused; a
      migration that mis-stamps its version is convicted.
- [x] **Migration idempotence (exact).** Reading a current envelope applies zero migrations;
      re-reading a migrated-then-serialized envelope applies zero more and is deep-equal stable.
- [x] **Replay determinism (exact).** Restores are pure functions of their bytes: no clock, no
      locale, no global registry; frozen results; later mutation of caller input cannot reach a
      created envelope.
- [x] **Identity verification.** `readAnalysisArtifact` recomputes the body hash and refuses a
      tampered artifact with `artifact.id_mismatch`; artifact ids are stable across input key
      order and cover operation, parameters, results, lineage, and tables.
- [x] **Teaching-error surface.** Unknown envelope keys, missing `asOf`, zone-less datetimes,
      conventionless flat rates, negative volatilities, ragged surface grids, both-or-neither
      chain bodies, non-Law-2 results, and malformed handles each fail with the registered typed
      code the tests assert.
- [ ] **Cross-package parity.** The spine's shock triple stays structurally assignable to
      `@totalfinance/risk`'s `Shock` (compile-time assertion in the Gate D slice that touches risk);
      TA's snapshot wrapper and the spine wrapper stay byte-identical (a shared-fixture test when
      TA migrates onto core's encoder — a later, deliberate TA-touching slice).
- [x] **Serial-landing conformance.** CLOSED 2026-08-20: 30 hand-curated Law-1 rows in
      `tools/manifest/packages/core.json` (five `artifact`-role factories), the
      `@totalfinance/core/artifacts` bundle budget (14 KB, schema-facade needle forbidden), api-report,
      generated docs/llms, and fixtures for the create/read heads; the deep probe then convicted
      and we fixed THREE defects the draft's own 53 tests had not caught (both content-hash heads
      hashed malformed envelopes — now delegating to the full read validators — and two
      null-as-omission coalescings in `createAnalysisArtifact.inputs` and
      `createMarketSnapshot.conventions`); the full ratchet suite is green at this commit with
      enforced 2,331 · defective 0.
- [ ] **Domain mappers.** `marketSnapshotFrom(...)` adapters (options market, FI curve set, chain
      rows) with equivalence tests (mapped snapshot prices equal direct calls — the Program 1 exit
      gate) land with the first consuming composition, not before.

## First-slice inventory (what review is looking at)

| File                                               | Contents                                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/artifacts/canonical-json.ts`    | `CANONICAL_JSON_VERSION`, `canonicalJsonOf`, `fromCanonicalJson`, wrapper guard                                                                    |
| `packages/core/src/artifacts/content-hash.ts`      | pure-TS SHA-256, `sha256Hex`, `contentHash`, `isContentHashString`, `CONTENT_HASH_PREFIX`                                                          |
| `packages/core/src/artifacts/migration.ts`         | `ArtifactMigration`, `AppliedMigration`, `createArtifactMigrationRegistry`                                                                         |
| `packages/core/src/artifacts/table-handle.ts`      | `TableHandle`, `createTableHandle`, `isTableHandle`, reserved Arrow media type                                                                     |
| `packages/core/src/artifacts/market-snapshot.ts`   | snapshot grammar, `createMarketSnapshot`, `readMarketSnapshot`, `marketSnapshotContentHash`, `isMarketSnapshot`                                    |
| `packages/core/src/artifacts/analysis-artifact.ts` | artifact grammar, `createAnalysisArtifact`, `readAnalysisArtifact`, `isAnalysisArtifact`                                                           |
| `packages/core/src/artifacts/scenario-set.ts`      | scenario grammar, `createScenarioSet`, `readScenarioSet`, `scenarioSetContentHash`, `isScenarioSet`                                                |
| `packages/core/src/artifacts/deep-freeze.ts`       | internal recursive freeze (not exported)                                                                                                           |
| `packages/core/src/artifacts/index.ts`             | the `@totalfinance/core/artifacts` entrypoint                                                                                                      |
| `packages/core/src/errors.ts`                      | four new registered codes: `serialization.unsupported_value`, `artifact.migration_missing`, `artifact.duplicate_migration`, `artifact.id_mismatch` |
| `packages/core/package.json`, `vitest.config.ts`   | the `./artifacts` exports entry and vitest alias (the only wiring this slice owns)                                                                 |

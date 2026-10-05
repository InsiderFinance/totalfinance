# Spec — Phase 3B: runtime and semantic surface closeout

> **Status: COMPLETE (3B.0–3B.6, closed 2026-08-19 at `af99ee107`).** Every measurement-validity
> condition through RV31 and every closeout row is closed. The 2026-08-23/26 review waves hardened
> the permanent gates—including declaration-derived branch/resource coverage—without reopening the
> phase. Stage 4 APIs must enter these ratchets in their first commit. The body below is the historical
> execution and evidence record, not an active queue. Live counters were refreshed for the
> [disclosed-holdings comparison](./disclosed-holdings.md) on 2026-09-25; this does not reopen 3B.
>
> Review rounds RV14 and RV17-RV31 raised findings against measurement validity. Each was
> independently reproduced before being fixed, and each fix carries the reproduction in its own
> comment. The dated paragraphs below are the record; the four that changed what a verdict MEANS are:
> positional holes (RV17), declaration-driven discovery (RV18), realization — a variant must exercise
> the branch it names (RV19/RV20), compiler-derived tuple metadata (RV21), presence at the parameter
> list (RV22), declaration-derived navigation routes (RV24), and independently derived truncation,
> complete callable surfaces, and constrained-generic traversal (RV31).
>
> **The honest form of the coverage claim** is "every declared alternative is measured OR explicitly
> `unmeasured`, never absent." The stronger sentence this header carried until RV18 — "every declared
> alternative is measured" — was false while it stood: 18 public paths reached fewer union nodes than
> they declare, and six published `enforced` with no alternatives at all. It is stated in its true
> form here and gated by `declared-coverage.test.ts`, which compares the DECLARATION against the
> ARGUMENTS actually built rather than the enumerator against itself.
>
> 1. **CLOSED (2026-08-11) — every declared alternative is measured or explicitly unmeasured, and
>    aggregated pessimistically.**
>    Branch identity no longer rides `attempt`: a path-keyed SELECTION fixes which alternative to
>    build, and `attempt` retries values within it. Alternatives are discriminator VARIANTS, not AST
>    branches — `strategyFromChain` records ten, one per declared `type`. The hand-written fixture is
>    now one LABELLED alternative among the declared set rather than the whole measurement, which
>    mattered more here than anywhere: a boundary earns a fixture precisely by having an interesting
>    union, so the contracts with the most alternatives were the ones being measured on one.
>    Independent sibling unions are never crossed; a union nested inside a selected branch is reached.
>    (`satisfiedBranch` matching on required KEYS is also fixed — discriminator-first, so
>    `{ type: 'coveredCall', shortDelta: 0.3 }` no longer selects the `strangle` branch.)
> 2. **CLOSED (2026-08-11) — no invalid hand-written fixture reaches measurement.** Every baseline is
>    now validated inside the generator, hand-written and synthesized alike, against the arguments it
>    actually passed. The named residual reached ZERO: each of the eight allowlisted mismatches was a
>    real defect with a real repair, not a rule too crude to express them. `options.dk` was a rename
>    the fixtures missed (`logMoneynessStep`); `market.expiry` was a key `OptionMarket` never declared;
>    the GARCH and HAR fits are now built by `fitGarch`/`fitHarRv` instead of hand-rolled literals that
>    omitted required blocks; and `collectAsync`/`streamAsync` argument zero is curated `open`, which
>    is what an `IndicatorStream` has always been. The allowlist is keyed by a machine-comparable
>    `category@path` fingerprint, so a DIFFERENT mismatch under a listed ID no longer stays green.
> 3. **CLOSED (2026-08-11) — the two missing mutation probes are in.** Numeric scalar coordinates now
>    receive NaN, and object enum FIELDS receive a same-typed invalid literal rather than only a wrong
>    primitive. See the coverage table below for what each one actually executes.
>
> The earlier reopening conditions ARE gone (the probe recurses to declared depth rather than reading
> top-level fields of the first overload (R7), series/container and constructor boundaries are
> measured (R7/R12), and MCP contracts are canonical JSON Schema rather than field names (R8)) — but
> those were different conditions, and clearing them is not this claim.
>
> Measured, from `public-enforcement.json`: **enforced 2,485 · partial 2,701 · defective 0 · unmeasured 187** of 5,373 candidates. Every unmeasured path carries a reason — `baseline-rejected` 56
> `no-input` 48 `external-callback-contract` 53 `callback-input-required` 4
> `async-result-unobserved` 6 `incomplete-baseline` 20
> — and each reason is documented with what it
> would take to close it. `branch-not-realized` is the newest and the most load-bearing: a call WAS
> built for that alternative and does not select it, which is different work from `no-input` and used
> to be reported as neither. It is an ALTERNATIVE-level reason and appears in no row: ZERO records
> carry it, 628 alternatives do, and the two populations are published separately
> (`summary.unmeasuredByReason` and `summary.alternativeUnmeasuredByReason`) precisely so a figure
> from one cannot be quoted as a figure from the other. This header said "one row" while the artifact
> recorded none, and the gate permitted it because it only checked that every ARTIFACT reason appears
> in the prose — never that the prose invents none. It checks both directions now. Those alternatives are enumerated by
> (record, variant, named outcome, built outcome) in `declared-coverage.test.ts` — an exact allowlist rather
> than a count, because a numeric bound lets one new mismatch replace one repaired mismatch without
> failing. These figures are GATED against the artifact
> (`contract-conformance.test.ts`); the September 9 source revision is checked locally on Node 26.5.0.
> Earlier Node 22.13/24/26 evidence does not certify this revision's still-required hosted matrix.
>
> The current artifact has 13,084 alternatives (6,707 unmeasured) and 76 receiver-grouping gaps.
> September R08 adds one genuine external-callback interface, `ExecutionJournalStore#transact`.
> The ratchet retains 185 for all other identities and allows only this named residual; tests of
> the memory/file implementations are not presented as proof of arbitrary caller-supplied stores.
>
> The earlier jump from 4,350 to 4,416 candidates was NOT new API and not new defects. 66 public boundaries had
> no enforcement record at all because a parameter typed `A & B` was classified `other`: `isObject`
> tested for `TypeFlags.Object`, an intersection carries `TypeFlags.Intersection`, and every test in
> that chain is a flag check — so the parameter fell through to the bucket the code itself describes
> as "nothing downstream can build". Unmeasurable meant uninventoried, and uninventoried meant absent.
> Recognizing intersections as objects added those 66 (54 defective, 12 unmeasured) and changed NOT
> ONE existing verdict, which is how we know it is coverage rather than drift. It also retired a
> phantom P-series entry, `extremeValueTailRisk`, whose `(returns, options)` signature had looked like
> two bare positional coordinates.
>
> RV31 moved 4,416 → 4,418 without adding API: three aliases of constrained-generic
> `finalizeResult` became visible object candidates, while optional callback
> `ShortRateTree.rollback` stopped masquerading as an object request. The net +2 is the semantic
> classifier correcting both directions.
>
> **Closed in two steps, and the first step's counter lied about the second.** Recognizing
> intersections as objects corrected the parameter KIND but not the recorded FIELD lists — a
> parameter's tree was looked up by declaration identity, and an intersection has none, so it borrowed
> the named constituent's and dropped every member declared inline. The metric that read
> "115 partially-walked → 0" was measuring the kind, not the fields: those parameters left the bucket
> because their classification changed, and a count that moves for a reason unrelated to what it names
> is the same defect as a bound that no longer binds.
>
> The tree is now BUILT from the parameter's own type, through the same `walkField` the declaration
> index uses — one implementation, two checkers, because two walkers is how the same declaration gets
> two answers. Nullish is stripped first: an optional intersection is `(A & B) | undefined`, a UNION,
> and six parameters kept an empty tree until that was handled. All 133 intersection parameters now
> record a complete tree; `barrier.monteCarloPrice` has its nine keys. `unmeasured` fell 224 → 207 (197 after #369, #394 and the choice-group retry) as
> boundaries became probeable, and `defective` rose 1,665 → 1,694 because more fields are now probed, then fell to 1,244 once 450 false convictions were withdrawn, —
> which is what unblocks 3B.1b-2's generated allowed-key lists.
>
> Read `defective 0` as the point of the phase rather than as a regression: it was 466 when
> enforcement was inferred from reachable guards, and the difference is measurement, not decay. 3B.1
> burns it down. The count DOUBLED on 2026-08-14 when the `null-when-nonnullable` mutation started
> running (9,205 probes): 2,629 records accept a `null` their declaration refuses — a guard reading
> `v == null` as absence rejects `wrong-type`'s string and reads as enforced on exactly the
> dimension it is not, so no earlier mutation could see the class. A verified specimen:
> `new AlmaStream({ period: null, … })` constructs a stream whose state is `weights: [null],
denom: 0` with no error, while the `sma` facade correctly refuses the same null — the rich-class
> constructors sit outside the facade guards, the cluster the latest-review findings table already
> names. The artifact publishes two DESCRIPTIVE counts, because one name for both is how a
> plan got built on the wrong one: **0 defective declaration templates** — distinct templates
> represented among the defective paths — and **0 defective measurement targets**, the records
> measured directly rather than inherited. Neither is an edit-site workload, and neither is claimed
> to be: whether one template edit fixes every path behind it is precisely what a declaration
> identity cannot answer, and it stays unknown until R14. The
> 134-boundary persistence cluster went first and is CLOSED (3B.1a); the shared enforcement path and
> both named seed defects are CLOSED (3B.1b-1) — the silent-miscompute class, where omitting a
> declared-required field reached the arithmetic and returned `NaN` as a success, is 31 boundaries to
> ZERO. The first Law-12 unknown-key cluster is CLOSED (2026-08-14, corrected same day after
> independent review): `math/statistics` went 19 boundaries to zero. The second and largest is
> CLOSED (2026-08-15): `options/exotics` went 41 boundaries to `enforced` — all 41, not partial —
> through the REUSABLE VALIDATOR and CHECKER-GENERATED specs (see the 3B.1b foundation entry).
> `baseline-rejected` is unmoved at 93: generated closed key lists over-closed nothing. `unmeasured`
> rose 163 → 166 for an honest reason unrelated to the cluster: `validateClosedRequest` is itself
> new public API, and a validator that takes a spec-plus-teaching request is a boundary the harness
> cannot synthesize input for — `no-input`, on it and its aliases.
> The rest is 3B.1b. Wave 6 and the
> [public naming normalization](./phase-3b-public-naming-normalization.md) is CLOSED (N9 re-closed after RV7: the queue-empty gate had counted denylist misses; the corrected queue went 199 -> 0 with every allowlisted name carrying a written rationale). Global sequencing lives in [`implementation-order.md`](../implementation-order.md).
> Permanent API laws and the concise phase ledger live in
> [`library-alignment-spec.md`](../library-alignment-spec.md); the settled per-operation and
> cross-cutting answers live in the
> [`Phase 3B decision ledger`](./phase-3b-decision-ledger.md). This document owns the implementation
> order, generated artifacts, commit boundaries, and acceptance evidence for Phase 3B. No package
> version may be published until every gate here closes.

### RV31 — final 3B.0 measurement closeout (2026-08-14)

The final review did not find another package migration. It found places where the measurement model
could still call two different TypeScript contracts equal, or trust a boundary that the artifact had
declared about itself. Those are 3B.0 defects: if the inventory loses a distinction, 3B.1 can repair
the wrong population while every counter remains green.

**Truncation is now independently proved in both directions.** The checker derives exact depth and
cycle frontiers; an artifact marker is honoured only at one of those frontiers, and every reached
frontier must carry a marker. The former `depth === undefined` acceptance path is gone, so an
artifact-only ghost cannot authorize itself with `truncated: true`. Seven unresolved
`BondFacade.explain` routes remain because TypeScript exposes the uninstantiated
`Args extends unknown[]` template instead of the concrete facade tuple. They are exact
implementation + route + kind + type entries with one written reason, and the test fails when any
entry becomes stale. There is no package, tier, count, or depth-wide escape hatch.

**A truncated subtree is unknown; its siblings are not.** Arm correspondence no longer reduces an
entire union to outer kinds merely because one arm contains a truncated descendant. Complete arm
fingerprints are compared as a multiset, with an explicit truncation-frontier token acting as a
wildcard only at the exact subtree where the producer ran out of budget. Maximum matching prevents
one wildcard from satisfying two arms. Plants mutate a known arm while another arm is truncated,
change an arm's outer kind at a legitimate frontier, and mutate a known sibling beside a recursive
truncated child; all are caught.

**Callable contracts are complete compiler-owned structures.** Every callable node now records every
overload, ordered parameter names and types, optional and rest status, return type, generic
constraints/defaults, and an explicit `this` parameter. Callable interfaces retain their authored
members (`stream`, `fromJSON`, `explain`) as well as their call signatures, and callback return
contracts are recursively walkable. This closes the cases where `() => string` and `() => number`,
or `(x?: A) => R` and `(...x: A[]) => R`, had the same identity and could inherit one another's
measurement. It also makes optional callbacks such as `ShortRateTree.rollback` callbacks rather than
object requests.

**Generic shape is neither erased nor confused with a concrete instantiation.** Traversal resolves a
type parameter through the checker's base constraint, records inferred binders separately from named
generic instantiations, walks optional tuples after stripping nullish arms, and rejects TypeScript's
array-like answers for `any`, `never`, and scalar/string types as contract containers. Exact
per-parameter checker trees are used only where a generic is concretely specialized, avoiding a
second field-ordering implementation for ordinary named objects. No parameter is simultaneously
marked inferred and instantiated.

**The synthesis and enforcement consumers use the same richer contract.** Complete callback and
generic facts participate in inheritance fingerprints, so evidence cannot cross between aliases that
accept different inputs. A direct callback inside a request is no longer mistaken for a receiver
method bag. An unconstrained callback result such as `Array<any>` gets the one universally valid
structural baseline, `[]`; this restored direct measurement of `register` instead of hiding a
process-global defective boundary behind `callback-input-required`.

The generated surface is now **7,863 public paths / 2,683 implementations / 1,553 input contracts /
1,926 result contracts / 384 validator identities**. The measured population is **5,373** records.
The exact residual branch list shrank by four: three recursive `register` mismatches disappeared and
the MCP safe-parse projection stopped masquerading as a caller-selectable branch. Every remaining
entry is still an exact built-versus-named identity and fails both when a new mismatch appears and
when an old one is repaired.

Closure evidence is executable: 38 checker↔artifact adversarial tests cover ghost and missing
truncation, known siblings around truncation, callable return/parameter changes, generic and tuple
structure, domains, union identity, and traversal; the full manifest suite passes **403/403**. Fresh
generation equals the committed signature, contract, and enforcement artifacts, generation is
deterministic within and across processes, and the prose counters are gated against those artifacts.
This closes 3B.0. Remaining defective and unmeasured records are the measured input to 3B.1, not a
reason to reopen the measuring instrument.

**Independent adversarial audit at `3c9a8b321` (2026-08-14).** A second agent attacked the gates at
the producer and regenerated the full artifact chain. Removing the `'deposit'` discriminator
produced 12 domain and 12 arm-identity disagreements; erasing callable return types while retaining
arity produced 2,053 callable-surface disagreements; restoring rendered-prefix truncation matching,
primitive-blind arm fingerprints, or unconditional truncation legitimacy each failed the plants
written for those defects. Same-machine artifact regeneration produced zero diff, and the complete
CI run passed 371 files / 7,920 tests. The audit found no live union with two callable arms, so a
synthetic same-arity callable-arm identity fixture now makes that future distinction load-bearing
before the public surface needs it.

**Non-blocking shipping-tooling follow-up.** Exact gzip output can move by roughly 0.1 KB across
zlib/platform combinations, which can make `pnpm artifacts:update` dirty `docs/bundle-size.md` on a
different machine. This is not an ungated budget: `bundle-size-doc.test.ts` holds entrypoints,
budgets, intents, and structural guarantees exactly, and holds the displayed measurement within
0.6 KB or 12%. Phase 4 shipping owns eliminating the contributor-noise channel by either choosing a
canonical generation environment or displaying a coarser stable measurement. The enforced byte
budgets remain exact, and this tooling polish is not a 3B.0 validity condition.

**AN IDENTITY THAT COLLIDES ON THINGS WHICH DIFFER IS A HASH, 2026-08-13 (RV30).** RV29 named arms by
a singleton literal, member names, callability and arity. That could not tell `number` from `string`,
so `number | ArrayLike<number>` becoming `string | ArrayLike<number>` kept the arm count at two and
the gate said nothing; and it could not tell the `'straight'` and `'annuity'` arms of
`bonds.amortizing` apart, so they collided, took occurrence suffixes in TRAVERSAL ORDER, and merely
reordering them invented two domain errors. The comment claiming collisions were safe and order
irrelevant was asserting what it had not established.

An arm is now fingerprinted completely and recursively — primitive kind, closed domain, nullability,
members with their names, requiredness and shapes, element, tuple positions, callable arity, nested
arms — canonicalised by sorting the parts whose order is not contractual, and derived separately on
each side. Two jobs that were conflated are now separate: fingerprints compare IDENTITY as an
order-independent multiset, while ROUTING uses each arm's RANK in that ordering, which is short and
stable where a whole fingerprint embedded in a route was neither.

Three alignments were needed to make the two derivations agree, each a real difference rather than a
tolerance: a callable is identified by ARITY, because the artifact records its return as rendered text
and comparing structure to text is the keying this gate replaced; a sequence is recognised by
`isArrayLikeType` OR by name, because the predicate answers false for `ArrayLike<number>`, the very
type the plant is built from, and the looser "has a type argument" rule called `Promise<T>` an array;
and an array whose element was never recorded says nothing, so both sides say the same nothing.

**TRUNCATION IS NOW DERIVED, NOT DECLARED, 2026-08-13 (RV30).** Any node carrying `truncated: true`
became a suppression boundary AND an exemption from identity comparison, so the review marked the
SHALLOW `bonds.amortizing.amortization` union truncated, corrupted a discriminator inside it, and the
gate reported nothing. A bound the measured thing declares about itself is not a bound. A claim is
checked against this walk's own budget — legitimate at or past the depth cap, or at a cycle, a lie
anywhere shallower — and only legitimate claims suppress. Where truncation is legitimate the arms that
WERE walked must still correspond by reduced shape and the truncated ones must account for exactly the
remainder, so a deleted arm still fails.

**AN INDEX IS NOT A NAME, 2026-08-13 (RV29).** Domain comparison excluded every route containing a
branch step, and the exclusion was reasoned from a real problem: the two walks order a union's arms
differently, so `|1` named different arms on the two sides. The conclusion drawn from it was wrong.
1,216 literal-bearing nodes across 151 public records live inside arms, and the review deleted the
caller-authored `'deposit'` discriminator from `curves.bootstrap`, `bootstrapProjection` and
`bootstrapMultiCurve`, regenerated every artifact, and watched all 7,900 tests pass.

Arm-count parity is cardinality. What makes an arm the SAME arm is its shape, so the route names it by
shape — its own closed domain if it has one, otherwise its members, whether it is callable, and its
arity — derived separately on each side like every other rule here. Keying the route by identity is
also what preserves the branch-to-shape association: erasing the index and comparing a pooled multiset
would let a domain MOVE between arms unseen, and a plant does exactly that to prove it does not.
Cardinality is no longer the whole test either: two unions with the same arm COUNT but different arm
IDENTITIES now disagree, which is what catches a discriminator that is renamed rather than removed.

Domains compared rose from 3,038 to 3,878. Re-running the review's producer-level deletion with a full
regeneration now reports twelve disagreeing domains. Two exemptions are stated rather than tuned: a
union whose own node is truncated, and a union one of whose ARMS is truncated — `additionalProperties`
is `false | true | JSONSchema` and the third arm is cut off with no members while the checker sees all
thirty. In both, the arm LIST is complete and the arm SHAPES are not, so count is compared and identity
is not. Without that distinction the change reported 37 disagreements that were the depth cap talking.

**A PLANT THAT DOES NOT PLANT THE DEFECT PROVES NOTHING, 2026-08-13 (RV29, corrected by RV30).**
RV28's sibling-collision plant renamed the truncated node itself and put a union on that node, which
is a different experiment; the review regressed `strictlyBeneath` to rendered-string prefix matching
and all eighteen parity tests passed.

> CORRECTED BY RV30. This paragraph claimed the plant had been rewritten against
> `FeaturePipeline#applyBars`. It had been — and then a botched de-duplication of a mis-spliced edit
> deleted the new test and left the old one, and this document went on describing a test that was no
> longer in the file. The review proved it the same way a second time. It is now genuinely the real
> pair: `explain().assumptions` declares both `conventions` (truncated) and `conventionsVersion`, the
> truncated node is untouched, the union is invented on the sibling, and the claim is checked by
> regressing the rule rather than by reading the diff.

**A FLOOR CANNOT SEE A DELETION, 2026-08-13 (RV28).** RV27 widened literal domains to numbers and
booleans, and the only check over them asserted that more than twenty numeric domains existed. The
review deleted the real `2 | 1` Vanna-Volga `order` domain from the producer, regenerated every
artifact, watched numeric-domain nodes fall 33 to 31, and the whole suite stayed green. A count is not
a comparison. Every domain the checker derives is now compared against the published one by exact
TYPED value, at the same route, in both directions — and reproducing the review's own experiment now
fails the gate. Deriving them independently immediately found a producer gap RV27 had missed:
`literalMembers`, the PARAMETER-level recorder, was still string-only, so `weekday: 0 | 1 | ... | 6`
published no domain while the identical type one level down published one. It delegates now, because
two implementations of "what values does this admit" is how one declaration gets two answers.

Five mutations are committed as plants — remove a domain, remove a value, add a value, retype `1` as
`"1"`, and the typed comparison that separates `true` from `false`. `'auto' | 1` is closed at the same
time: a mixed-primitive literal union was refused by the domain recorder AND by the arm rule, so it
would have been recorded as neither.

> CORRECTED BY RV29. This paragraph said the `true`/`false` case was asserted rather than planted
> because "every singleton boolean domain on the surface today sits at an ARM route". The count was
> wrong — 32 sit inside arms and 7 outside — and the conclusion drawn from it was wrong twice over,
> because excluding arm routes was itself the P0 RV29 found. Arms are addressed by identity now, so
> in-arm domains are compared like any other and the boolean mutation is a committed plant.

**A PREFIX IS NOT AN ANCESTOR, 2026-08-13 (RV28).** Truncation suppression compared RENDERED routes
with `startsWith`, which was wrong twice. It suppressed the truncated NODE ITSELF rather than only
what lies beneath it, so three real `SafeParseResult` unions were deleted at truncated nodes with
nothing to notice; and `.conventions` is a string prefix of `.conventionsVersion`, so a truncated node
masked an unrelated SIBLING and an invented union there passed ten of ten. Routes are `NodeStep[]` on
both sides now and suppression is strict descent, step by step. Rendering a route and then guessing
its structure back from punctuation is the same mistake as keying this gate on printed type text,
which the route vocabulary replaced. 330 truncated nodes are within the checker's reach, so the
correction is measurable rather than theoretical, and both plants fail under the old rule.

**`false` IS OUTSIDE THE DOMAIN `true`, 2026-08-13 (RV28).** The probe declined to violate a singleton
boolean domain, reasoning that sending `false` "tests a boolean's ordinary handling rather than a
domain violation". Backwards: whether the boundary rejects `false` is the ONLY thing separating
`enabled: true` from `enabled: boolean`. A boundary that checks `typeof === 'boolean'` and stops was
convicted by nothing and published `enforced` on `omit-required` and `wrong-type` alone. Six tests
cover it — scalar, nested field, both polarities, and the type-only boundary that must be convicted by
`invalid-literal` — and all six fail against the previous behaviour.

**A DOMAIN IS A SET OF ADMITTED VALUES, NOT A SET OF STRINGS, 2026-08-13 (RV27).** The producer
declined to record arms for a literal-only union because the values were "already recorded as
`literals`", and the recorder it was deferring to returned nothing on the first non-string. So
`order?: 1 | 2` and `{ calls: 1 | -1; puts: 1 | -1 }` were skipped by both halves of one rule and
published as a bare `number` — 16 nodes across 9 records with neither arms nor a domain, and no way
for the probe that exists to send an inadmissible value to know there was anything to violate. Two
halves of a rule disagreeing is invisible from inside either half, and the gate that would have
caught it stated the same string-shaped rule for the same reason. Domains now carry strings, numbers
and a singleton boolean, each value keeping its own type: `1` and `'1'` are different admissions, and
flattening both to text made a numeric domain and a stringly one share a fingerprint, a membership
test, and a probe value. The probe now sends a non-member IN THE DOMAIN'S OWN PRIMITIVE — it had been
sending a string at a numeric domain, which any `typeof` check answers.

**WHAT THAT ACTUALLY BOUGHT, STATED EXACTLY.** 39 numeric and 39 boolean literal domains — 31 numeric
and 7 boolean outside union arms, 8 numeric and 32 boolean inside them (RV29 corrected an earlier "33
numeric", which counted only part of the surface) —
and the enforcement artifact gains named alternatives it could not express before:
`exposure(config.convention)` now enumerates `:calls=1` (measured) and `:calls=-1`
(`branch-not-realized`), where the object arm previously had no discriminator at all. It did NOT make
`config.convention.calls` a probe coordinate — the measured baseline selects a string arm, so there is
no object there to descend into — and the review's attribution of the live `resolveSigns` defect to
this gap is therefore incorrect. That defect is fixed at the boundary, on its own merits, and the
domain work is justified by what it measures rather than by that.

**TRUNCATION IS PART OF THE SHAPE, 2026-08-13 (RV27).** `truncated` says the generator stopped short
of the declaration. It was emitted by the producer, absent from the interface every reader was typed
against, and therefore absent from `canonicalNode` — so a node walked to the end and one cut off at
the depth cap had the same identity, and an arm could gain or lose the flag without moving any digest.
It is serialised now. Validation deliberately does NOT abstain on it: a truncated arm's members were
read and are correct as far as they go, and refusing to check them would turn a partial description
into no measurement. What the flag must prevent is two states of knowledge sharing one identity, which
is a fingerprint problem rather than a validation one.

**A NAME IS NOT AN IDENTITY, 2026-08-13 (RV27).** The route-keyed gate above matched artifact
records to declarations by NAME SUFFIX and pooled every match into one bag of facts, then asserted
only that a route existed somewhere in that bag. Four defects walked through it: an arm count
changing three to two; arms stripped from ONE published spelling while a sibling covered for it; a
union removed from a CONSTRUCTOR, which nothing traversed; a union removed from a later OVERLOAD,
which nothing read. The comparison is driven from the artifact now — each published record resolves
its own declaration through its `implementation` identity and is compared against its own facts, at
every signature kind, every signature index, every argument index, by route and by arm count, in both
directions. The four experiments are committed beside it, because a claim that a gate would catch
something is worth what the attempt to break it is worth. Two of them still passed after the rewrite
and found more: a parameter the checker reached no union in was never examined at all, and the walk
descended into no OPTIONAL object member anywhere, since the properties of `T | undefined` are none.

**A CEILING PERMITS WHAT IT WAS NOT WRITTEN FOR, 2026-08-13 (RV27).** Thirty parameters were excused
as shapes the harness could not reason about; seven were. The rest were ordinary request objects whose
members were resolved by looking a declaration up in an index built from EXPORTED types — so an
unexported request type resolved to nothing, and three of them published `enforced` about a contract
nothing had read. Those are read off the type now. The exclusion is an exact list of instances and
their reasons, checked in both directions, and what remains in it is two class receivers and one
external protocol: things a caller obtains rather than authors.

**MEASURING MORE MEANS MEASURING WORSE, 2026-08-13 (RV27).** `enforced` fell from 1,160 to 1,123 and
the fall is the result, not a regression: forty-six boundaries had been reporting enforcement against
inputs the harness could not describe, and several of them fail once described. The ratchet is
re-seated on the measured figure with that reason written beside it, which is the same discipline the
two re-seats above record and the reason this is not a tolerance.

**THE ARM WAS NOT THE ONLY THING RECONSTRUCTED, 2026-08-13 (RV27).** A union of tuples had its own
validation path that fired whenever any arm carried positions and rebuilt every arm as a bare array,
discarding the element contract, members, call signature, return and nested arms of the others. It was
the same lossy reconstruction this round removed everywhere else, surviving in the one place that
pre-empted the fix. Two more survived at the parameter level: a sequence element and a tuple position
were described by flat member lists, so a union element resolved to the members its arms share — one,
for a four-arm instrument type — and positions had nowhere to hold theirs.

**THE PARITY GATE IS KEYED BY ROUTE NOW, AND READS ZERO, 2026-08-13 (RV26 close).** The
checker-to-artifact comparison joined on RENDERED TYPE TEXT and cost three rounds of notation fixes
for 36 false accusations. Rebuilt the way the review specified — keyed by parameter plus recursive
ROUTE, compared occurrence by occurrence — it reports **zero** unions the checker reaches and the
artifact does not record, over 608 unions across 413 parameters.

The route vocabulary already existed: `walkManifest` had been returning a route with every node since
the shared reader landed. The work was making the checker walk step in the same units — members are
`{property}`, a sequence's element is `{element}`, a tuple's slots are `{position}`, a callable's
result is `{returns}`, an arm is `{branch}` — and mirroring two rules the producer follows: a branch
costs no depth, and the cycle guard holds ANCESTORS rather than everything visited. The second
mattered: keyed by (route, type) the walk re-entered `JSONSchema.additionalProperties` at every new
route and reported four "missing" unions per recursive schema, at routes the producer stops on
deliberately.

**Two findings came out of the plant experiments rather than the rewrite.**

The first plant PASSED. Stripping the arms from `ExitRule#when` changed nothing, because the walk
visited `getExportsOfModule` and a method hangs off an exported TYPE — 678 of the artifact's records
are methods and 23 of those carry a union, so "every occurrence" was quietly "every occurrence on a
free function". Methods are covered now, and the same plant fails.

The second plant passed too, for a better reason: the gate unions the facts across every public id of
one callable, so stripping two of `ironButterfly`'s three spellings left the third carrying the route.
That is correct — they are one declaration — and it means a plant has to strip them all.

**What the gate deliberately does not claim.** 30 parameters are described with a contract identity
and NO structure at all — `atmTermStructure(surface: VolatilitySurface)` is the shape, a class that is
mostly methods, which synthesis handles by obtaining a real instance rather than describing one. A
union inside a shape the artifact never described is a different and larger gap than a dropped arm, so
it is counted and bounded separately rather than folded into a number that would report one
undescribed contract as ten missing arms.

And the sweeps in `declared-coverage.test.ts` now carry an explicit 180s budget. They take ~20s alone
and 46s under a full-suite run competing for CPU, against vitest's 45s default — so one failed on the
clock while asserting nothing, which reads as a defect in the measurement and is a defect in the
budget.

**THE PARITY NUMBER WAS MOSTLY THE GATE, 2026-08-13 (RV26 follow-up).** The checker-to-artifact
ceiling opened at 340 and was reported at 58 after the arm work. Splitting that 58 into "the artifact
records these arms somewhere" and "no arms anywhere" put THIRTY-SIX of them in the first bucket:

    9   the per-record id join missed scoped exports (`bonds.amortizing` does not end `:amortizing`)
    23  `x?: number | undefined` versus `x?: number` under `exactOptionalPropertyTypes`
    4   `Array<T>` versus `T[]`

`ironButterfly`'s `number | { strike; callPremium?; putPremium? }` — one of the review's own named
examples — is recorded with two arms and was reported missing purely because of the `| undefined`
suffix on an optional member.

Three successive notation fixes to one comparison is the finding, not the fixes. The gate joins on
RENDERED TYPE TEXT, and rendered text is a display form rather than an identity: each normalization
revealed the next spelling difference, and there is no reason to believe the fourth does not exist.
The review specified the durable design — key by parameter plus recursive ROUTE, compare occurrence
by occurrence — and that is what this gate should become. Until then its ceiling of 22 carries an
unknown residue of the same noise, which is recorded next to the number rather than left implied.

What remains is at least plausible as genuine: 6 `Greeks | ExtendedGreeks` in a callback's return, 6
`string | number` (`asOf`), 3 `KalmanObservation`, 4 MCP/JSON-schema shapes, 3 singletons.

**THE ARMS WERE NOT EVERYWHERE, AND THE GATE COULD NOT SEE IT, 2026-08-13 (RV26).** RV25 recorded a
union's arms as complete nodes and reported the surface covered. It was not, and the round's own
parity gate is the reason the gap stayed invisible: it checked ROOT parameters whose printed type
shows a top-level `|`, which is 88 occurrences and blind to every alias and every nesting level. An
independent recursive scan found 340 nested unions with no arms at all, over 320 records and 154
implementation identities, 120 of them on rows reporting `enforced`.

**The full suite was RED and I reported it green.** `from-chain-contract-parity.test.ts` — a PACKAGE
test, outside the manifest subset I had been running — read `parameter.branchFields` after that
representation was retired. A second reader, `contract-probe.test.ts`, read the same removed key and
did not throw: it walked one level inside object arms by hand, so its optional-field claim quietly
covered less of the surface while still passing. Reporting a subset as the whole is the same error
class this document spends forty findings on, committed by the author of the gates.

Both now read through `manifest-nodes.ts`: one place where the published node shape is written down,
one place where its children are enumerated. A consumer cannot walk four of six relationships and
report a clean sweep, because enumerating the children is no longer something a consumer does.

**Six mechanisms, each fixed at the level the defect lives on.**

1. Arms are emitted from `walkField` GENERICALLY, before any `kind` test. They used to be attached
   inside the `array` and `object` cases, so a union that read as numeric, string, callback or other
   was recorded as an opaque type name.
2. Validation receives the ARM ITSELF. `branchNode` rebuilt each arm as `type + fields`, discarding
   its element, positions, call signature, return and nested arms — so
   `number | ReadonlyArray<'left' | 'right'>` accepted `['bogus']` as a legal baseline.
3. Discovery DESCENDS INTO the arm it selects, rather than walking that arm's object fields, so a
   union inside a selected arm's element or tuple position is a site with alternatives of its own.
4. Identity is a canonical RECURSIVE digest of the complete node. The previous hash read rendered
   text and each arm's shallowest fields, so an alias-resolved element changing from numeric to
   string, or a callback arm's arity changing, left the site key and the pooling fingerprint unmoved.
5. Plain `boolean` is one semantic type again. The checker models it as `true | false`; recording two
   arms invented alternatives no caller can choose.
6. The parity gate is now checker-derived and recursive, with the rendered-text check kept as a
   secondary regression test.

**The identity tests were proving the wrong thing, and that is worth recording separately.** RV25's
fixtures varied arm metadata and rendered type text TOGETHER, concluded identity moved, and reported
that widening the digest was unnecessary. The text alone was carrying the identity; the metadata
could have been ignored entirely and every case would still have passed. The fixtures now hold
rendered text constant and vary only what an alias hides.

**A UNION'S ARMS ARE NODES, 2026-08-12 (RV25).** The first round in a while that MOVED the artifact,
because the previous ones had been correcting mechanisms that happened to agree with the answer. This
one found a grammar the inventory could not express at all.

`parameterInfo` described each arm with `fieldTreeForType`, which answers one question: what named
members does this arm declare? For `ArrayLike<number>` the answer is none — `members()` drops
declarations from `lib.*.d.ts`, correctly, because `length` is nobody's contract. The arm then read as
`null`, and a `.some(tree => tree !== null)` gate discarded the WHOLE union when no arm survived.
`number | ArrayLike<number>` recorded no branches, no types, nothing: one grammar standing in for two,
on 78 occurrences spread over 33 distinct implementations of the public surface, with every gate green.

Both levels now walk arms with one shared `armNodes`, so an arm is described the way any other node is
— kind, element, positions, literals, call signature, nested arms — and an arm with no named members
is still an arm.

Alternatives published went 307 -> 649. The alternative-level not-realized count went from 27 to 30
and the built-versus-named residual from 27 to 36; both grew because the first did, since a reachable
alternative the builder cannot construct is visible in those counts rather than absent everywhere.

> Stated as prose, and worded around the gates on purpose. The coverage gate matches a three-column
> mutation row ANYWHERE in this document, and the checklist gate takes the first count that precedes
> the word for "implementations" — so a summary table here was read as the mutation-coverage table,
> and a count of affected implementations as the checklist's own figure. Both are first-match-anywhere
> parsers over the whole file. Ungated prose rots; prose that collides with a gate's parser is worse,
> because it fails a check that is about something else entirely.

Three boundaries left `enforced`. They had been reporting it on the strength of measuring ONE of
several alternatives; the others are visible now and are not enforced. That is the correction.

**Four defects surfaced while landing it, each caught by measurement rather than by reasoning.**
`armNodes` charged every arm a level of the depth budget for a step nobody takes, so 80 arms of named
object types came back truncated and empty — it presented as "36 alternatives vanish whenever readers
prefer the nodes", which read at first as the per-arm walk being weaker. It was not weaker; it was
stopped a level early. A curated NAME-table value outranked a NAMED branch, so `selectQuotePrice /
arg1#2` was published as MEASURED from a call passing `'bid'` — six false measurements across two
boundaries. The builder never built an ARM, only the container, so `vectorized`'s variants #1 and #2
got #0's numeric series. And `selectBranch` took `branchFields` as its own parameter type, which made
it invisible to the reader migration: it kept type-checking against nodes that still carried the
arrays and answered "no branch" for every union once they were deleted, costing ten boundaries their
probe mutations with no verdict moving.

**`maxSharpe` is not a hang.** It was recorded `probe-timeout` in a supervised run and measured fine in
the unsupervised drift gate — the artifact depending on machine speed. Giving
`transactionCosts.perUnitTurnover` its scalar arm means every probe now reaches a 5,000-iteration
projected-gradient solve: 158.2s against a 90s budget, while every other boundary is under 1.0s and
the whole pass is 167s. The budget is a HANG detector, so it moves to 300s with that table written
beside it. The cost is the price of measuring something that was never measured.

**The three legacy arrays are deleted.** `branchFields`, `branchTypes` and `branchTuples` each
described an arm in the shape of one thing an arm might be; `branches` describes an arm as an arm.
`public-contracts.json` drops from 21.30MB to 20.40MB and `public-enforcement.json` regenerates
byte-identical. `UnionSite` keeps its paired arrays deliberately — it is an internal working record,
not a published contract.

**Two new gates, both proven by planting.** A checker-to-artifact parity gate compares the artifact's
ARMS against the artifact's rendered TYPE — two independent derivations, so the "both sides walk the
same walker" blindness cannot recur — and asserts no retired key survives anywhere in the published
contracts. A second gate asks whether the site digest needs widening over the new nodes, varying
element, tuple arity, literals, call signature and requiredness one at a time; it PASSES, so the
widening this round's review asked for is unnecessary and was not done: every variant id would have
churned for a property already held.

**Latent, and fixed anyway.** `RouteStep` gained `{ position: n }`. A tuple's positions are separate
declarations sharing a container, and with only `element` the walker had no way to say "position 1" —
so `[number, A | B]` declared ZERO union sites. No public declaration carries that shape today, so
both artifacts regenerate byte-identical; the walker is fixed regardless, because "the surface happens
not to contain it" is a fact about today's surface.

**FIVE THINGS THAT WERE TRUE ONE STEP TO THE SIDE, 2026-08-12 (RV24).** A fresh adversarial pass. None
of it changed a verdict, which is the pattern by now: the artifact has been correct for several rounds
while the MECHANISMS producing it kept being right only where they had been tested.

1. **`element?: boolean` could not say where a union lives.** It recorded "somewhere under an array",
   so the reader descended exactly once: `Array<Array<A | B>>` read branch 1 back as branch 0, and
   `Array<{ choice: A | B }>` resolved `arg0.items.choice` against the ARRAY and read nothing at all.
   A depth integer fails the same way once properties and elements interleave. Each site now carries a
   declaration-derived ROUTE — `argument 0 → element → property "choice"` — navigated in order however
   deeply the two alternate, and kept separate from the display path.

   Fixing the reader exposed the builder: `Array<Array<A | B>>` was built as a numeric MATRIX, because
   the text shape matches and nothing checked what the elements are. A matrix is an array of NUMBER
   arrays; the declared element decides now.

2. **A union of TUPLES was not treated as a union.** `branchTuples.find(...)` took the first arm with
   positions and ignored the selection, so `[number] | [string, number]` built `[1]` for its `#1`
   variant — and worse, a tuple-union node was never recorded as a site at all, because sites keyed on
   `branchFields` and tuples expand to none. Both spellings produce arms through one helper now.

3. **The comparator whitelist was still a list of fixed reproductions.** Six more: a non-writable array
   `length` (which decides what the element walk even looks at), an own `"01"` pseudo-index (`/^\d+$/`
   matches it and the language does not — `length` never counts it), non-extensible views, altered view
   prototypes, `"01"` on a typed array, and a REGISTERED symbol, which cannot be a `WeakMap` key and so
   threw where it should have compared equal to itself. Canonical indices are defined the way the
   language defines them, `length` is validated, and a view is ordinary only when it is a stock view.

4. **The "exact" allowlist was not exact.** 27 occurrences collapsed into 21 entries, because six
   signatures each covered TWO variants — so repairing one member of a pair moved nothing, which is
   precisely the claim the allowlist existed to make true. `variant.id` is in the key now: 27 entries
   for 27 occurrences.

5. **The header gate permitted a false claim.** It checked that every ARTIFACT reason appears in the
   prose and never that the prose invents none — so the header could say one row carries
   `branch-not-realized` when zero do. Row-level and ALTERNATIVE-level reasons are different
   populations, published separately (`unmeasuredByReason`, `alternativeUnmeasuredByReason`) so a
   figure from one cannot be quoted as a figure from the other, and the gate compares both directions.

Verdicts unchanged at enforced 1,283 · partial 1,629 · defective 1,328 · unmeasured 176; 307
alternatives, zero truncation. Zero rows carry `branch-not-realized`; 27 alternatives do.

**THREE ORDERINGS AND A COUNT, 2026-08-12 (RV23).** The closing pass. Nothing here changed a
verdict; all three defects were latent, and that is the point — each is a rule that was correct where
it was tested and wrong one step to the side.

1. **The tuple metadata branch was UNREACHABLE.** It sat below `tupleMemberTypes()`, so it only ran
   for tuples the text parser failed to recognize — which is the opposite of what RV21 claimed to
   have done. An adversarial `Array<['a\'b,c', boolean]>` carrying an authoritative per-position
   contract still produced `[["x","x"], …]`. All 21 public array-of-tuple paths are `[string, number]`
   or `[number, number]`, which the parser reads correctly, so the artifact was unaffected and the
   defect lived entirely in what happened next. An ordering that only matters when the fallback fails
   is not a fallback; it is dead code with a comment claiming otherwise. Metadata is consulted first,
   and the test now proves synthesis CONSUMES it rather than that it exists.

2. **Element reading was a heuristic about the data, not a fact from the declaration.** RV22 read an
   array's element when the element carried a matching DISCRIMINATOR — right for tagged unions and
   silently wrong for `Array<{ a: number } | { b: number }>`, where the branches differ by shape
   alone: it built `#1` and reported `#0`. The walk knows when it is descending into an element, so
   `UnionSite.element` records it and the reader consults the declaration. A guess about the data
   cannot stand in for a fact about the declaration, however often the guess is right.

3. **The comparator's whitelist was a list of fixed reproductions.** Each round closed the cases the
   review named and left the ones it did not: writable versus read-only array index, extensible versus
   sealed object, array versus array SUBCLASS, typed array with extra own state, and — the decisive
   one — two views sharing a buffer versus two independent buffers, identical in contents and offsets
   and different in exactly the way a probe that writes can see. Ordinary data is now defined
   completely (prototype, extensibility, own-key shape, per-key descriptors, and backing-buffer
   topology for views); everything outside it is opaque identity. A partial whitelist is a promise to
   be surprised by whatever it forgot.

4. **The residual is an exact allowlist, not a bound.** `mismatches <= 27` let one new mismatch replace
   one repaired mismatch without failing — a ratchet that counts can be satisfied by arithmetic. Each
   of the 27 is named by (record, named outcome, built outcome), so repairing one REMOVES an entry and
   introducing one fails immediately. They are FOUR mechanisms rather than the two earlier rounds
   claimed: a union in a callback's return contract, a presence gate inside a callback's return, a
   shape-only branch of a root union (`classifyStrategy`'s two array arms, indistinguishable once
   built), and an element union under a selected branch (`register`'s `items#4`).

Verdicts unchanged at enforced 1,283 · partial 1,629 · defective 1,328 · unmeasured 176.

**THE GATE STOPPED AT THE PARAMETER LIST, 2026-08-12 (RV22).** Five findings, and the first two are
the same mistake twice: a rule written for nested FIELDS that was never carried to the two places the
same shape occurs.

1. **An optional ARGUMENT had no gate.** `spectralRisk(returns, options?)` published `arg1#0` and
   `arg1#1` and never the call that omits `options` — the shape every caller writes first, and the
   one an `omit-required` probe depends on existing. Root arguments are gated by the same code that
   gates fields now, and an absent gate genuinely omits the argument rather than renaming a present
   one.

2. **The gate's SCOPE did not reach the builder.** The enumerator qualifies a union under a present
   gate as `…:present.…`; synthesis had reduced the gate to a bare materialization path and looked
   the union up unqualified, so a variant naming branch `#1` built branch `#0`. Reported honestly as
   `branch-not-realized` — no false evidence — and an avoidable generator failure. The gate's
   qualified scope is installed for the subtree it opens.

   The realization check had the matching defect: it compared a site's `scope`, a RENDERED outcome id
   like `arg0:mode=deep`, against a map keyed by the internal digested key `arg0~7gkadw`. That can
   never be true, so the reverse direction passed everything — including a variant naming a child the
   call never built. There is ONE helper now (`realizationGaps`), used by the generator and the gate;
   the duplicated oracle carried the same bug, which is what duplicating an oracle is for.

   **A third cause turned up under the same number, and it was a READER bug.** Array elements share
   their container's path, so the value at `arg0.ois` is the ARRAY while the union's branches describe
   one instrument. A named object branch has no judgeable type text, so the array "satisfied" it and
   the reader answered branch zero — reporting 51 correctly-built variants as failing to realize
   themselves. The generator was right and the reader was wrong, which is the harder direction to
   notice. An element is now read as an element when it IDENTIFIES itself by a declared discriminator.

   `branch-not-realized` fell 71 -> 51 (scope) -> 27 (element reading).

3. **Array-of-tuple synthesis still used the text parser.** Direct tuples read the compiler metadata
   and `Array<Tuple>` elements did not, producing `[["x","x"], …]` — right arity by luck, wrong types.
   The element is a node like any other and is built by the call that builds a direct tuple.

4. **The comparator's last collapses.** Writable versus read-only, an array carrying extra own state,
   a typed-array view at a nonzero offset, and a shared-reference graph versus duplicated equals. All
   four fall through to identity now; a repeated object describes as a back-reference, so aliasing is
   part of the description.

5. **An unmeasured ROW published no alternatives.** "Measured or explicitly unmeasured, never absent"
   has to hold when the answer is unmeasured, or it is a claim about the easy half. `defineIndicator`
   reported one row-level `callback-input-required` and nothing about its shapes;
   `Position#whatIfCube` did the same through the receiver path, which had not been taught what the
   module path already knew. Both publish every declared alternative carrying the row's reason, and
   the gate no longer exempts unmeasured rows.

Alternatives 270 -> 307, of which 74 are absence outcomes. Verdicts unchanged at enforced 1,283 ·
partial 1,629 · defective 1,328 · unmeasured 176.

**The one residual, bounded and named rather than asserted away.** 27 built calls still select a
different branch from the one they name, in two mechanisms, both inside callbacks: a union in a
callback's RETURN contract (`normalSample`'s `getState` names `algorithm=xoshiro128ss` and the stub
returns `mulberry32`), and a presence gate nested inside a callback's return
(`defineOptionPricingEngine`'s `price.greeks`). Every one is published `branch-not-realized`, so no
evidence rests on any of them, and the separate gate proves that no measured alternative comes from an
unrealized call. It is a ratchet in `declared-coverage.test.ts`: it may fall and must never rise.

**TUPLES COME FROM THE COMPILER NOW, 2026-08-12 (RV21).** The last item the reviews left open, and
the only one whose fault was the APPROACH rather than a bug in it.

Tuple structure was re-derived by parsing rendered type text. Every lesson that parser had to be
taught arrived as a defect, in both directions: top-level commas (`[string | number, boolean]` read as
three positions, a legal call rejected), arrows (`>` counted as a closing bracket, driving depth
negative and splitting `P | null` inside a callback), quoted literals (`['a,b', boolean]` read as
three positions), template literals, nested tuples checked only for being arrays, inline object
positions checked only for being objects. Six lessons, six defects, and the checker knew the answer
before the first one.

`contract-fields.ts` now records `tuple` — one node per position, from
`checker.getTypeArguments` and `elementFlags` — for every fixed-arity tuple, and `branchTuples` for a
union of them. Absent where a REST or VARIADIC element makes arity open, because then position is not
the contract and a per-position reading would be a different kind of wrong. Optionality is recorded on
the node, so the legal arity RANGE is derivable rather than a single number the text reader could only
abstain on.

Writing it found one more live defect, which is the argument for having written it. A UNION OF TUPLES
starts with `[` and ends with `]`, so the bracket test admitted it and the splitter — walking a string
whose brackets close and reopen — produced FOUR positions from
`[number] | [number, number, number, number]`. `restoreRandomNumberGenerator`'s legal one-element
state was rejected as "declares exactly 4 elements, got 1": the validator refusing a call the language
accepts, from a shape it had misread as something else. Both arities are accepted now and `[1, 2]` is
not.

**39 of 39 tuple-shaped fields on the committed surface carry compiler metadata, and a gate holds it
there.** The text reader stays in the file for a declaration the inventory has not recorded — but it
has no work, and a new tuple field arriving without metadata fails CI rather than silently reviving
the parser and its class of defects. The 190 remaining text-parsed tuples are labelled ARGUMENT LISTS
(`[bond: Bond, options: X]`), which `tupleElements` splits into positional coordinates; that is a
different mechanism with a different job, and it is not value validation.

Verdicts unchanged at enforced 1,283 · partial 1,629 · defective 1,328 · unmeasured 176, with zero
flips. That is the expected result and worth stating plainly: RV19 and RV20 had already corrected
every case the text reader was getting wrong on this surface, so replacing it changes no number
today. What it changes is that the next tuple shape does not have to become a defect first.

**PRESENCE IS PART OF IDENTITY, 2026-08-12 (RV20).** RV19 gave absence a NAME and left it outside
IDENTITY, which is half a model and behaves worse than either half alone.

Deduplication still keyed on normalized branch selections, and normalization assigns branch `#0` to
every site — so "field absent" and "field present, branch `#0`" produced the same key and collided.
The enumerator also skipped `alternatives[0]` on the old assumption that branch `#0` IS the canonical
call, which stopped being true the moment absence became the canonical one. Between them: **30
declared outcomes across 17 exported paths never enumerated**, 23 of them the branch-`#0` call and
seven the absence.

The second failure had the same root. Materialization compared the selection's QUALIFIED keys
(`arg0.output.value:type=array.length~1a2b3c`) against ordinary child paths
(`arg0.output.value.length`), which cannot match once a union sits anywhere above — so `register`'s
`length#1` request contained no `length`, and the row published `defective` about a branch it never
carried. The realization check missed it because it treated any unobserved scoped site as
legitimately unreachable without checking whether the parent branch was actually taken.

**The fix is one model, not three patches.** A PRESENCE GATE is a node with two outcomes, absent and
present, sitting ABOVE the unions an optional field guards. Everything below it is discovered only
when it is present — the same nesting rule branch selection already uses. From that single change:

- absence and every present branch enumerate, including `#0`, because they are different choices at
  the same node rather than a flag beside it;
- two required unions under one optional object are materialized together and named together,
  instead of one being labelled absent while the call carries it;
- materialization is driven by the gate's own answer in PLAIN paths, which is the vocabulary the
  builder walks;
- `alternativeOf` reports gate outcomes either way, so absence is observable and therefore
  verifiable.

`VARIANT_LIMIT` rose 24 -> 48. An optional union has (1 + branches) outcomes rather than
branches-many, and `optionsBacktest` went from 20 to 30 — the measured ceiling. A limit below the
widest real contract does not bound cost, it bounds EVIDENCE.

**And the gate I wrote last round was vacuous.** It built `${row.id} / ${alternative.id}` keys and
matched them with `entry.split(':')[0]` — every record id CONTAINS a colon, so the split truncated to
the package name, nothing ever matched, and the filtered list was empty on every run. A gate that
cannot fail is worse than no gate: it occupies the place where a real one would go. It uses structured
`{ recordId, variantId }` values now, and checks BOTH directions — every realized outcome must be the
one named, and every named outcome the call can reach must have been observed.

Also closed: the fixture comparator is now restricted to an explicit ORDINARY DATA subset — sparse
arrays, symbols, `-0`, null-prototype objects, non-enumerable state and accessors all fall through to
identity rather than being merged by their visible shape. And the last tuple cases: an inline object
position is judged by its MEMBERS and their types at every depth, and a template-literal type is read
as a string with commas in it rather than as several positions.

Verdicts unchanged at enforced 1,283 · partial 1,629 · defective 1,328 · unmeasured 176. Alternatives
242 -> 270, of which 55 are absence outcomes, 64 presence outcomes and 71 `branch-not-realized`. Zero
truncation.

**Closed in RV21/RV23 — past tense, because the work landed.** Tuple validation WAS text parsing over
rendered TypeScript, and every case that reached a review was closed one at a time while the APPROACH
stayed wrong. `contract-fields.ts` records `tuple` and `branchTuples` from the checker now, synthesis
consults them before the parser, and a gate asserts the text reader has no work on the committed
surface.

**A VARIANT COULD BE `enforced` WITHOUT BEING EXERCISED, 2026-08-12 (RV19).** RV18 made discovery
read the declaration, which was right and only half the problem: the enumerator now names alternatives
the SYNTHESIZER does not necessarily build. Three ways a named branch failed to materialize —

- an OPTIONAL field is omitted from a minimal baseline, and a union inside it is never reached;
- an ARRAY ELEMENT was built straight from `element.fields`, bypassing `element.branchFields`;
- a CALLBACK RETURN was built in an isolated default context, so its union always took branch zero.

— and all three produced a call that answered to a name it had not earned. Both
`researchProtocol.trials` variants synthesized the identical request, with no `trials` property at
all, and `arg0.trials#1` was published **`enforced`**. My own audit found 76 of 216 buildable variants
across 30 public paths in that state.

**The gate I added in RV18 could not have caught it, and that is the part worth recording.** It
compared declaration-derived selection keys against enumerator-derived selection keys — both produced
by the same walker — so it verified the enumerator against itself. Every check in this phase that has
failed has failed that way: it ran, it passed, and it was asking the wrong question. The replacement
reads the two sides from different places: expected from the DECLARATION, observed from the ARGUMENTS
actually built.

Four repairs, one per way the guarantee leaked:

1. **Materialize what the selection names.** A variant carries the sites it EXPLICITLY fixed, distinct
   from the defaults normalization filled in, and an optional field is built when a variant names a
   union at or under it. Every other call still omits it, so the minimal baseline an `omit-required`
   probe depends on is untouched. Array-element unions route through branch selection like any other
   node; callback returns build in the caller's context.

2. **Absence is its own alternative.** Where a union sits behind an optional field, the call that
   omits the field reaches NO branch — naming it `trials#0` claimed it exercised the first. It is
   named `trials:absent` now (39 alternatives), which is the review's rule: if omission remains a
   meaningful baseline, represent it distinctly rather than labelling it a union branch.

3. **Realization is checked before measurement.** The built arguments are read back and compared to
   the intended selection; a mismatch is `branch-not-realized` — a new reason, deliberately not folded
   into `no-input`, because "nothing could be built" and "the wrong thing was built" want different
   work. 46 alternatives carry it.

4. **A duplicate discriminator no longer selects directly.** `{ kind: 'same'; a } | { kind: 'same'; b }`
   labelled every fixture `#0`, because the first alternative whose tags matched won and the typed
   matcher was never reached. A tag that does not identify a branch now NARROWS the candidates and
   their declared shapes decide.

Also closed: the fixture comparator now fails closed for real (functions are equivalent by object
IDENTITY or an explicit `declareFixtureEquivalence`, never by source text — `make(1)` and `make(2)`
render identically and close over different values; class instances are opaque whether or not they
expose a key; primitives carry their type and typed arrays their constructor). That immediately found
a real pair: `dupireLocalVolatility` and `localVolatility.fromImplied` are deliberate twins whose
fixtures each minted their own `() => 0.2`. They share one surface object now, so the twinning is a
fact the harness checks rather than a claim in a comment.

And four tuple-validation defects: a union POSITION whose named arm was unjudgeable collapsed
`false + unknown` to `false` and rejected legal values; a nested tuple was checked only for
being an array; an inline object literal was checked only for being an object; and the splitter did
not track quoted literals, so `['a,b', boolean]` read as three positions. **This is a stopgap and is
labelled as one in the code.** The durable fix is compiler-generated recursive tuple metadata: the
inventory knows these shapes exactly, and rendering them to text and re-parsing them here throws away
information that was never lost until we threw it away.

Verdicts: enforced 1,286 -> 1,283, partial 1,626 -> 1,629, defective 1,341 -> 1,328, unmeasured
163 -> 176. The defective fall is the same correction as the enforced fall: **15 convictions were
withdrawn because the call that produced them did not reach the branch it accused.** False defects and
false enforcement are the same defect seen from two sides, and only measuring realization finds both.

**THE DECLARATION IS THE SOURCE OF TRUTH, 2026-08-12 (RV18).** Seven findings. The first two
invalidated published evidence; the rest were identity and comparison rules that were true at the
root and false everywhere else.

1. **Union discovery was a side effect of SYNTHESIS, so declared alternatives were ABSENT rather than
   unmeasured.** `enumerateVariants` walked the attempt-zero call and collected whatever unions that
   walk happened to pass. A minimal baseline omits optional fields on purpose — that is what makes an
   `omit-required` probe mean anything — so a union inside one was never seen. A declaration-to-
   generator audit found 18 public paths across eight scoped callables reaching fewer nodes than they
   declare, and six published `enforced` with NO alternatives while declaring a nested union.
   `researchProtocol.trials` declares two shapes and its row claimed enforcement of branches nothing
   had built. Discovery now reads the declaration (`declaredSites`), and enumeration is no longer
   gated on buildability: an alternative synthesis cannot build is published `unmeasured`, which
   already denies the boundary `enforced`. Alternatives 144 -> 242; rows carrying them 38 -> 64; six
   boundaries moved `enforced` -> `partial`, which is the whole point of the fix.

2. **Nested field unions were validated VACUOUSLY, because one concept had two names.** Field-level
   branch types were recorded as `branches` and parameter-level ones as `branchTypes`; the recursive
   validator read only the second. Field unions therefore reached it with no type text, every branch
   was judged as a bare shape, and `objectGap` — which returns "valid" for anything that is not a
   plain object — accepted a scalar at ALL 57 nested union occurrences in the committed trees. One
   name now, and the library-wide sweep runs RECURSIVELY rather than at parameter roots only: a gate
   that checks only the roots is how a whole class stays invisible behind a number that reads
   complete.

   Two parsing defects surfaced underneath it. `>` was counted as a closing bracket, so depth went
   NEGATIVE inside `{ build: (c: C) => P | null }` and `P | null` split into two bogus members — one
   unjudgeable, and one unjudgeable member abstains the whole check. And an INTERSECTION
   (`EntryCommon & { structure: 'ironCondor'; … }`) read as a bare named type, so nothing in it was
   judgeable at all. Both are now handled, and `optionsBacktest.entry` — the last nested union in the
   library to accept `42` — no longer does.

3. **Alternative identity was PRESENTATION, so one call could be measured twice.** Enumeration named
   a variant by the single site it fixed; fixture labelling named it by every site it selects. The
   same call carried two names, `planVariants` deduplicated on the display string, and one
   reproduction produced four measurements for three distinct calls. Identity is now the complete
   normalized SELECTION — implied defaults written out — computed once and used by both. Two related
   repairs: an array fixture for `Position | ReadonlyArray<number>` was labelled as the object arm
   (structural matching accepts a non-object vacuously), and
   `{ kind: 'same'; a } | { kind: 'same'; b }` emitted one alternative for two shapes because
   `alternativesFor` deduplicated on discriminator TEXT. A tag that does not identify its branch now
   keeps the branch index in the name.

4. **The "complete contract fingerprint" was complete at the root only.** Nested fields used a
   shape-only branch digest, so `A -> fieldsA, B -> fieldsB` and `A -> fieldsB, B -> fieldsA`
   fingerprinted identically one level down; callback RETURN contracts were omitted entirely, so two
   callbacks rendering the same `(x) => Result` and expanding to different `Result`s compared equal.
   One recursive digest now pairs branch types with shapes at every depth and carries the expanded
   return. No bad group was demonstrated — the guarantee was false before any group depended on it,
   which is the right time to fix it.

5. **Tuple validation REJECTED legal TypeScript.** `tupleMemberTypes` replaced every comma with a
   pipe before splitting, so `[string | number, boolean]` read as three positions and `['ok', false]`
   was refused as "declares exactly 3 elements, got 2". A validator that refuses a call the language
   accepts is the same class of error as one that accepts a call it does not — it just fails the
   other way, and this one had no gate pointed at it. The depth-aware splitter is now shared with the
   labelled-tuple reader, and each position is validated as its own union.

6. **The conflict rule could not see the conflicts it exists for.** `describeCall` identified
   functions by ARITY, truncated arrays after eight elements, and collapsed deep values, so two
   fixtures containing `() => 1` and `() => 2` compared identical: no error, and the second fixture
   discarded silently by the rule meant to protect it. Functions are compared by source text now,
   arrays are not truncated, and anything genuinely opaque gets a process-unique marker so it never
   equals anything — including another copy of itself. Failing closed is the only honest default when
   the alternative is publishing one author's call under a verdict another's would not have produced.

7. **Tracker and tooling.** The header no longer says canonical grouping is open while a later
   section says it is implemented; `summary.mutationsAttempted` corrected to `mutationsExecuted`; the
   `fixtureSource` and alternatives comments now describe what is actually emitted. `refresh-spec-
figures.mjs` is idempotent against a formatted document — it rewrites a table row only when the
   numbers moved, rather than re-emitting unpadded columns and failing `format:check` — and a
   substitution that matches nothing now exits non-zero instead of reporting success over a stale
   gated figure.

**FIVE WAYS THE HARNESS CERTIFIED ITS OWN GAPS, 2026-08-12 (RV17).** Five findings, none of which
changed a single published verdict, and all five of which changed what the verdicts MEAN. That is the
shape worth naming: a measurement defect that moves a number announces itself, and one that does not
is only visible to someone who checks what the rule actually covers rather than what it claims.

1. **Positional holes — the builder compacted, and JavaScript binds by position.** `adjustDate(date,
convention?, calendar?)` was synthesized as `[date, calendar]` and its coordinates labelled
   `[date, calendar]`, so the runtime received the calendar object as `convention` while `calendar`
   kept its default. The synthesized date is a business day, so the call returned before examining
   the malformed convention: nothing threw, and every mutation of argument 1 was filed as Calendar
   enforcement evidence about an argument the function never saw as a calendar. Holes are preserved
   through the last supplied parameter and trailing ones trimmed; the artifact now shows the
   correction — those failures moved from `arg1` to `arg2`, and genuine new evidence appeared at
   `arg1` (the convention enum) and `arg0`.

2. **The "recursive" baseline validator certified malformed unions and tuples.** `objectGap` returns
   `null` — valid — for anything that is not a plain object, so every OBJECT branch of a union was
   satisfied VACUOUSLY and `baselineGap([parameter], [42])` certified `42` against
   `restoreRandomNumberGenerator`, `deflatedSharpeRatio`, `spectralRisk`, `strategyFromChain` and
   `phiValue`. Branches are judged through the full walk now, against their own aligned type: object
   coordinates accepting a scalar went 13 → 0 across 5,989 real baselines. Filtering to object
   branches was the first attempt and broke `classifyStrategy` immediately — two of its three
   alternatives are arrays — so EVERY branch is judged, shape or no shape. Tuples were unchecked in
   both directions and both halves were wrong the same way, which is why nothing caught it:
   `[42, "wrong"]`, `["ok"]` and `["ok", 1, 2]` all passed against `[string, number]`, while
   synthesis emitted `Array<[string, number]>` as an array of sixty-element arrays of `"x"`. Arity
   and each position now come from the declaration. The library-wide bound is EXACT rather than a
   percentage: a rate cannot tell an unjudgeable coordinate from a judgeable one the walk failed to
   reach, which is precisely how it permitted thirteen known misses.

3. **A union's identity was its PATH, so same-path unions under different branches were one node.**
   `arg0.inner` under `outer=left` and `arg0.inner` under `outer=right` are two different
   declarations, and both halves of the harness took them for one. Enumeration DROPPED alternatives:
   the path was already in the global reached-set from the first walk, so descending into the second
   outer branch found nothing new and never queued the alternatives that exist only there. Labelling
   MISATTRIBUTED: a hand fixture selecting a branch of the second union was matched against the
   first's alternatives and reported under one of ITS names — real evidence filed against a contract
   the call never touched. Identity is now the path QUALIFIED by the ancestor selection, plus a
   digest of the branch schema; `alternativeOf` respects scope, so a fixture is never matched against
   a union its own branch cannot reach. **Honest accounting: this recovered ZERO alternatives in the
   library today** — the one nested union family (`register`'s `output.value` → `items`) has no
   divergent sibling, so only its NAMES changed (`arg0.output.value:type=array.items:type=boolean`,
   qualified where it used to be bare). The defect was real and reproduced; its current cost is
   naming and a landmine, not lost coverage, and saying otherwise would be the overclaim this phase
   keeps correcting.

4. **The callable-group ruling was implemented in parts, and the missing parts were invisible.** Only
   the FIRST fixture in a group was pooled, so a group whose second name carried a fixture for
   another alternative silently lost it. `record.fields` was excluded from the group key — correctly,
   it is package-qualified — and then never pooled, so a group could be measured through the poorest
   member's index. `fixtureSource` was suppressed whenever it equalled the record's own id, so a
   reader could not distinguish a self-fixtured measurement from a synthesized one (56 rows carried
   provenance; 2,212 do now, 1,451 of them genuine borrowers). And receiver methods were left out of
   the grouping pre-pass entirely, because `resolveCallable` cannot reach a prototype method from a
   module — grouping now reads the owner's PROTOTYPE, which is the same function object every
   instance shares and constructs nothing. The receiver path also planned its own variants, and
   planned them differently: a hand fixture became the whole measurement and union enumeration was
   switched off, which is the defect the module path had already been fixed for. Both now go through
   one `planVariants`.

   **Residual at this historical review:** 31 receiver members remained ungrouped because their owner
   is obtainable only from a factory (`Bond`, `YieldCurve`) and has no prototype on any module
   export. The count is published as `summary.receiverGroupingGaps` rather than left as an unstated
   limit. And measured honestly: **no receiver group has more than one member today**, and none of
   the 30 measured receivers declares a union parameter or carries a hand fixture — so unifying the
   two paths changed no number. It removed a divergence that was one aliased receiver away from
   mattering.

   One correction found by regeneration rather than by reading: routing both paths through
   `planVariants` made `fixtureFor` uniformly variant-aware, which exposed a pre-flight check that
   fabricated its own `hand: false` probe variant. That asks synthesis to build an input for a
   boundary that is fixtured PRECISELY BECAUSE synthesis cannot — 89 boundaries were reported
   `no-input` while holding a working input the harness had already built. The check now asks the
   plan whether any declared alternative is measurable.

5. **The inheritance fingerprint lost the branch-to-shape wiring.** `branchFields` and `branchTypes`
   were sorted INDEPENDENTLY, so `A → fieldsA, B → fieldsB` and `A → fieldsB, B → fieldsA` compared
   equal: the same multiset of types, the same multiset of shapes, wired differently. Sorting the
   JOINED `(type, shape)` records keeps order-insensitivity and the association at once.

Verdicts across all five: **unchanged** at enforced 1,292 · partial 1,620 · defective 1,341 ·
unmeasured 163, executions 16,287. These fixes removed FALSE EVIDENCE and false NAMES rather than
moving counts, which is the point and the reason the totals are not the measure of them.

**THE SETTLED RULE FOR ALIAS MEASUREMENT (ruling, 2026-08-12) — IMPLEMENTED; ONE RESIDUAL.** A hand fixture is keyed to
one public spelling, so an alias of a fixtured boundary is measured against synthesis instead.
`collectAsync` is the visible case: the scoped name builds a real `IndicatorStream` from its fixture
and records `async-result-unobserved`, while both umbrella spellings fail to build one and record
`callback-input-required` — the same runtime function, the same contract, two different accounts of
what is wrong with it. 656 fingerprint-equal groups have some names fixtured and others not, covering
1,333 alias records; two groups visibly disagree today.

The ruling:

> Associate fixtures with the semantic callable group — resolved runtime function object + complete
> contract fingerprint + invocation/receiver mode. Measure that group ONCE, then attribute the
> evidence to every matching public path.

Measure once, not per alias. Re-running each alias adds physical executions and no knowledge; it
inflates `mutationsExecuted` by fan-out; and — decisively — a STATEFUL callable produces
order-dependent results, which is the exact failure canonical measurement was introduced to remove
(`stoch`/`stochastic`, R11).

**The group key cannot be computed from the artifact, and that is now measured rather than asserted.**
Keying on `implementation` is wrong because it is a declaration-template identity: 24 different
technical-analysis indicators share one `.explain` template. Dropping `record.fields` from the
fingerprint merges them — they become one group with mixed `defective`/`partial` verdicts. Keeping
`fields` splits genuine twins instead, because the field index is package-qualified: `buildStrategy`
carries 79 field paths under its scoped name and 3 under the umbrella, for one declaration. Neither
key works offline, so grouping must happen AFTER resolution, on the runtime function object — and
`record.fields` must be POOLED within the resolved group rather than used to identify it.

Sequence: fingerprint first (DONE, `50b9c419`); then resolve and group every public path before
measurement; pool the group's hand fixtures; validate each pooled fixture against the shared
contract; identify each fixture's full union selection; use one deterministic known-valid fixture per
alternative and synthesize the rest; measure once per alternative; fan verdict, reason, alternative
evidence and coverage out to every alias. Contradictory fixtures inside one group FAIL generation —
that is either a stale fixture or an insufficient fingerprint, and both want a person.

**Status (2026-08-12, after RV17):** every step of that sequence is implemented — group after
resolution on the runtime function object; pool the group's fixtures (all of them, not the first);
validate each; label each by its full union selection; one fixture per alternative and synthesis for
the rest; measure once; fan out. Contradictory fixtures inside one group FAIL generation
(`ConflictingFixturesError`, naming both paths), and identical fixtures under two names do not — that
is agreement, not conflict. `record.fields` is pooled PER OWNER TYPE (`poolFieldIndex`), which is the
granularity synthesis reads it at; pooling by "whichever member holds the most paths" is wrong and
was measured to be wrong, because a member can hold more paths in total while holding NONE for the
owner a given parameter needs. The one residual is the 31 factory-only receivers recorded above.

Accounting is unchanged in meaning: `mutationsExecuted` counts only the canonical group's physical
probes, `mutationsCovered` the attribution across equivalent paths, `inherited` the alias paths
receiving canonical evidence — plus `measurementSource` (the deterministic canonical path) and
`fixtureSource` (the path that contributed the selected fixture) for auditability. A group-level
`async-result-unobserved` propagates to every alias: the "never inherit a gap" rule existed only
because inputs were path-local and some aliases had worse synthesis luck, and pooling removes that
cause. A result reached through a known-valid shared fixture is group evidence, not a path-local gap.

**THE SETTLED RULE FOR UNION AGGREGATION (ruling, 2026-08-11).** Recorded here because it is the
contract the open blocker above must satisfy, and because a rule that lives only in a review thread is
a rule that gets re-derived wrong.

- **The BOUNDARY stays the unit.** Union alternatives are evidence INSIDE a boundary, never new
  candidates. Alternative-level telemetry is added alongside the headline counts, not folded into them.
- **Aggregate pessimistically**, on this ladder, in this order:
  1. any alternative defective → `defective`
  2. every alternative enforced → `enforced`
  3. at least one measured, another partial or unmeasured → `partial`
  4. no alternative measured successfully → `unmeasured`
- **`partial` means:** no authoritative defect was observed, some contract evidence exists, but the
  complete declared contract was not conclusively measured.
- **An unbuildable branch and a rejected branch are different facts.** A branch the harness cannot
  establish a valid baseline for is `unmeasured`. A KNOWN-VALID baseline the runtime rejects is a
  defect — `valid-call-rejected` — not merely unmeasured. Collapsing the two is how a contract that
  refuses correct input reads as a gap in the harness.
- **Measure discriminator VARIANTS, not AST branches.** Structural branches that share a field shape
  still execute different runtime paths, so each discriminator literal earns its own evidence.
- **Identify an alternative by full path and semantic discriminator** — `arg1.options:type=ironCondor`,
  `arg0.config.entry:structure=calendar`. NOT the Cartesian product of independent nested unions:
  exercise each alternative while holding the other coordinates at canonical valid values, and add
  curated combinations only where coordinates genuinely interact.
- **Branch identity must not ride the retry heuristic.** Enumerate branch × discriminator literal
  explicitly; retry value alternatives WITHIN a variant; keep a verdict per variant.
- **Publish `alternativeSummary`** per boundary (`total`/`enforced`/`partial`/`defective`/`unmeasured`)
  plus per-alternative evidence, and the same shape globally, so "defective on one of ten" and
  "defective on all ten" are distinguishable without changing what `defective` means.
- **Inheritance requires the COMPLETE branch set.** Not an appended branch index: one canonical
  recursive callable fingerprint over every overload, positional parameter identity, expanded tuple
  elements, scalar types and literal domains, requiredness and nullability, nested field schemas, every
  union alternative, and input policy — with semantic branch fingerprints canonically sorted before
  hashing, so branch ORDER cannot change identity.

**A UNION WAS MEASURED ON ONE BRANCH, 2026-08-11 (RV14 P0-5).** The harness returned after the first
baseline that ran, so a HEALTHY union never reached its second alternative — and branch identity rode
`attempt`, the retry counter that also walks curated values and admits choice-group optionals. One
number selecting three independent things cannot be read back as branch coverage. The two are now
separate: a path-keyed selection fixes WHICH alternative (`arg1:type=ironCondor`), `attempt` retries
values within it, and each alternative earns its own verdict which is then aggregated on the ladder
above. Seventeen records carry alternatives; library-wide the artifact publishes a global alternative
tally (`summary.alternatives`), where a boundary with no union contributes exactly one — itself.

**The interesting unions were exactly the ones going unmeasured, for a structural reason.** A
hand-written fixture stopped enumeration dead — and a boundary earns a fixture precisely by having a
union too interesting for synthesis to guess. So the fixture is now one LABELLED alternative among the
declared set (`alternativeOf` reads which one it selects) and synthesis supplies the rest.
`strategyFromChain` went from one measured call to ten, one per declared `type`.

**What it found, and what it correctly refused to find.** `costAwareKelly` was `enforced` and is
`defective`: its fixture's branch honours its contract, and two sibling alternatives accept a
wrong-typed `horizonPeriods` and return a result. Five more boundaries lost `enforced` to `partial`
because an alternative could not be measured at all — which is the ladder working, since a union that
promises every alternative cannot be called enforced on the strength of some of them.

The first version of the rule ALSO reported twenty-three `valid-call-rejected` defects and nine
`enforced` -> `defective` flips, and every one was wrong. It reasoned that a sibling's rejection is a
defect when the canonical call ran — true only when the two differ in nothing but the discriminator,
which collapses exactly where the canonical is a hand fixture and the siblings are synthesized. The
library had been explicit: "an ATM straddle needs a spot", "delta-based strike selection needs a delta
on every call quote". Those are correct refusals of an under-specified request, and believing them
would have published the harness's own synthesis gap as a library defect. The bar is now what the
ruling set — an unbuildable branch is UNMEASURED, and a defect is claimed only where a deliberately
authored, declaration-valid fixture is refused. That count is currently zero.

**COVERAGE IS NOW A PUBLISHED NUMBER, 2026-08-11 (RV14 P0-3).** `failures` records only results whose
verdict is not `rejected`, so a fully enforced dimension leaves NO trace — and "this mutation records
nothing" reads identically whether the boundary refused it or the probe never ran. `invalid-literal`
recording zero library-wide was exactly that ambiguity, and no assertion over the artifact could have
resolved it. `summary.mutationsExecuted` now reports what the harness actually RAN:

| mutation                | executed | covered |
| ----------------------- | -------: | ------: |
| `omit-required`         |   13,311 |  33,963 |
| `wrong-type`            |   16,970 |  43,396 |
| `non-finite`            |    9,376 |  24,458 |
| `invalid-literal`       |    1,951 |   5,003 |
| `unknown-key`           |    2,739 |   6,513 |
| `null-when-nonnullable` |   26,245 |  65,980 |

**EXECUTED and COVERED are different facts, and the table this replaces mixed them.** `executed` is
what physically ran; `covered` is what a path may claim, directly or attributed from an alias twin.
They diverge by alias fan-out — `unknown-key` ran 2,682 times and is credited across 6,440
route-level mutation checks — so reporting the second as though it were the first would overstate
execution more than twofold. Failures are split the same way (currently zero direct and zero
attributed) so a finding count is never read against the wrong denominator, and the ratchets guard
EXECUTION: alias fan-out must not hold a total up while a probe quietly stops running.

Execution also FELL where it should — `non-finite` 3,357 -> 2,690 — because undeclared sample keys are
no longer probed. Those runs mutated fields no contract declares, and losing them is the point.

Two probes were missing entirely. A numeric SCALAR coordinate never received NaN, though `wrong-type`
cannot cover it — NaN IS a number, so a `typeof` guard admits it and the arithmetic silently produces
NaN, the exact silent-miscompute class 3B.1b-1 exists to close. And an object FIELD declaring literals
was probed only with a wrong PRIMITIVE, so a boundary doing nothing but `typeof x === 'string'`
refused it and read as "enforces the declared set" while accepting any string at all. Adding both:
**409 boundaries accept a value outside a declared literal domain**, and `defective` moves 1,334 →
1,346.

The counts had to be made to BOUND the findings before they could be quoted: `failures` is copied to
an inheriting record at two sites, and copying evidence without copying coverage reported 409
`invalid-literal` failures against 386 attempts. A coverage number smaller than the findings it bounds
is worse than none.

**A GUARD THAT NAMED ITS OWN SUBJECT AND MISSED IT, 2026-08-11 (RV14 P0-1).** The
`async-result-unobserved` reason exists because scoring mutations against an unawaited result records
passes for evidence never collected, and its comment names `collectAsync` and `streamAsync` as the
two boundaries in question. The check tested for a THENABLE. `collectAsync` returns a promise and was
caught; `streamAsync` is an `async function*`, whose returned object carries `Symbol.asyncIterator`
and `next` and no `then` — so the guard written for it sailed past it. Nothing in a generator body
runs until the first `next()`, so its guards never executed, every mutation came back as the
generator OBJECT, and the artifact marked `streamAsync` DEFECTIVE on four accepted mutations
returning `{}`. It is now `unmeasured / async-result-unobserved`, with the generator closed rather
than advanced — driving an iterator needs timeout supervision and a source that yields, and an honest
gap beats a verdict nobody earned.

**A PARITY TEST THAT ASKS THE RUNTIME FINDS THINGS, 2026-08-10 (RV13 P1-7).** Extending
`from-chain-contract-parity` from field PLACEMENT to runtime SEMANTICS — omit each required field,
mistype each field against its declared kind, put a non-finite number where a finite one is declared,
and pass an invalid discriminator, for every one of the ten variants — turned up five defects in
`strategyFromChain` itself. `spot: NaN` was ACCEPTED and returned four legs, because `resolveSpot`
returned it unchecked and the finite guard only ran on paths that need a spot; the same held for
`shortDelta`, `wingWidth`, `width`, `strike` and `stockPrice`. Omitting `expiry` or `shortDelta` was
refused with "no quotes to select from for a delta-targeted leg", which never names the field the
caller got wrong. `price: NaN` came back complaining about `source`, a field the caller never wrote.
`farExpiry` and `right` accepted numbers. Fixed, each error now naming the caller's own spelling — but NOT all fixed, and the earlier claim to
that effect was too broad: RV14 found `price: 'bogus'` still passing the local string check before a
downstream `source` error, `"not-a-date"` passing both expiry checks despite messages promising ISO
dates, `farExpiry` unchecked against `expiry`, `shortDelta > 1` accepted, wrong primitives answered
with `input.out_of_range`/`input.invalid_enum` rather than `input.wrong_type`, and the tests asserting
message SUBSTRINGS rather than exact codes. Those are open 3B.1 work.
three boundaries moved `defective -> partial` as a result.

The test's own precondition is the part worth copying: it asserts the UNMUTATED canonical call is
accepted before trusting any mutation result. Without that, "the runtime did not reject this" and
"the runtime never got far enough to look" are the same silence — the first version of this test ran
against an empty chain and read the second as the first.

**HALF OF MANY CALLS WAS NEVER EXAMINED, 2026-08-10 (RV13 P0-2).** The probe walked the arguments and
did `if (!isPlainObject(argument)) continue`, so a SCALAR coordinate beside an object was skipped
entirely. `selectQuotePrice(quote, source)` recorded 41 results, every one on argument 0, while
`source`'s five declared literals sat in the inventory untested. Every measured boundary pairing an
object or series with a scalar coordinate carried a verdict that spoke for a call only half examined.

A second, quieter half: synthesis expands a labelled rest-tuple into several arguments and skips an
optional non-object parameter entirely, but enforcement handed the probe the raw PARAMETER array — so
`fieldTrees[i]` described a different slot than `args[i]` wherever a labelled tuple was declared. `synthesizeCall` now returns
the arguments and their coordinates from ONE walk, making alignment a property of construction rather
than something a second walker re-derives and keeps in step.

unmeasured 197 -> 179 · defective 1,244 -> 1,337 · enforced 1,137 -> 1,136
(defective then fell to 1,334 when `strategyFromChain` began refusing what it had accepted — see below)

**Read the enforced number falling by one as the point, not a regression.** 21 boundaries moved
`enforced -> defective`: they were only ever enforced on the half of the call the harness looked at.
`invalid-literal` joins the vocabulary for the same reason — `wrong-type` substitutes a NUMBER, which
a bare `typeof x === 'string'` check rejects, so "enforces the declared domain" and "rejects a wrong
primitive" were indistinguishable. It records ZERO across the library, which reads as "every enum is
enforced" and would read identically if the probe never fired; `contract-probe.test.ts` makes the two
distinguishable by requiring a boundary that ignores its enum to produce an accepted result.

**450 boundaries were never defective, 2026-08-10.** `defective` falls 1,694 → 1,244, and the
withdrawal is a correction rather than a fix to the library: 142 of them move to `enforced` and 308 to
`partial`.

A UNION HAS A THIRD READER. #369 made the builder and the validator agree ("build one branch, accept
one branch") and missed that the probe reads the same parameter through a third path: it was handed the
MERGED tree, so a field existing only on the chosen branch was treated as an undeclared extra and its
mutations could not convict. `strategyFromChain` accepted deletion of `wingWidth` — a field its branch
declares REQUIRED — and the harness filed it `advisory`; worse, a branch-only field whose value is not
a number lost its `wrong-type` probe entirely, with nothing in the record to show it was missing. The
probe now receives the branch the argument actually satisfies. `wingWidth` convicts, `spectralRisk`
reaches `enforced` because its branch-only field is optional IN ITS BRANCH, and `enforced` moves
1,134 → 1,137.

`omit-required` was being probed on fields the contract declares OPTIONAL. Deleting one is accepted —
that is what optional MEANS — and the acceptance was recorded as an authoritative failure.
`blackScholes.price` was `defective` with exactly one failure, `omit-required/dividendYield`, while
the call that omits it returns 9.87. Repo-wide that was 1,800 false entries across 847 records, 450 of
which rested on nothing else: 27% of the `defective` headline describing correct code.

The rule had been WRITTEN DOWN twice and implemented neither time — `AUTHORITATIVE_WHEN_DECLARED`
says "Deleting an optional field must succeed", and `probeContract` documents that `omit-required`
"fires only on fields the contract declares REQUIRED". It is a restoration: before 383c6fdb the guard
read `if (node?.optional === true) continue`, and that commit demoted it to `if (!present) continue`
while adding the `optional-wrong-type` probe for absent optionals. Prose in a comment is not a gate,
so it is now `tools/manifest/contract-probe.test.ts`, whose last case asserts the invariant against
the committed artifact rather than against a fixture.

**What moved the counts before that, 2026-08-09.** Ten boundaries, in three unrelated ways, and none
of them is the library getting worse.

Five became measurable once the harness could express a CHOICE GROUP. "Exactly one of `quantity` or
`notional`", "at least one of open/high/low/close/volume", "`w` or `impliedVolatility`" — every
alternative in such a group is correctly declared OPTIONAL, because none is individually required, so
the minimal required-only baseline supplies none of them and is refused. The declaration is right and
the library is right; the harness simply had no way to say "one of these". A retry now admits the
first `attempt` optionals, which is safe for the same reason the date fallback is: a retry only
happens after attempt 0 was REJECTED, so a wider call can never displace a working baseline, and
attempt 0 stays minimal so `omit-required` keeps meaning what it says. `SimulatedBroker.submit`,
`barsFromColumns` (three paths) and `prepareSlices` now measure. `tipsIndexRatio` still does not, and
the reason is worth recording: it wants EXACTLY one of two, so admitting two fails it exactly as
admitting none did — a blunt rule reaching its limit rather than a defect.

Four became measurable because the harness stopped handing a date a value that is not one. `'x'` is the
right last resort for a free-form string and a guaranteed failure for a date-typed one, and twelve
boundaries were answering exactly that — `Invalid ISO date "x" (expected YYYY-MM-DD)`. The fallback now
reads the field NAME, at the three places a generic string is produced, so it can only ever replace a
value that was already going to fail: `calendars.expirations` and `calendars.tradingDaysToExpiry` (both
paths each) now measure, and all four land on `enforced`. Three more moved past the date error into the
cross-field class rather than out of it, which is why `input.out_of_range` rose 45 → 47 while
`input.wrong_type` fell 18 → 11 and then rose to 17 when the choice-group retry re-typed six
refusals. Nothing regressed: no boundary went from measured to unmeasured. As committed the three
input buckets are `input.out_of_range` 19, `input.missing_field` 11, `input.wrong_type` 0 (the
September 16 valuation-instant law moved four `out_of_range` and one `missing_field` refusal into the
typed `time.valuation_instant_required` bucket, 5) — stated in that canonical form because a
narrative "rose X → Y" cannot be gated, and this sentence rotted once already when a later commit moved the counters and left the prose pinned to the intermediate state.

The fifth is `phiValue`, and it is worth naming because the direction looks wrong: it left
`unmeasured / baseline-rejected` and arrived at `defective`. That is the harness gaining the ability to
ask, not the library getting worse — `SSVIPhi` is a discriminated union, synthesis built the merged
tree (`{ kind }` alone, which satisfies no branch), and the boundary correctly answered "phi.lambda is
required." Built from ONE branch it is measurable, and the first thing measuring it found is that it
accepts an undeclared key — the Law 12 class of 3B.1b-2, which is where it now counts. See #369.

Two other numbers in the block above are corrected rather than refreshed. "All 133 intersection
parameters" was never the population: the gate that produced it selected parameters by testing whether
a rendered type string contained `&`, so every compound contract behind an alias was outside the count.
The measured figure is 156 public compound parameter occurrences, and the 13 boundaries recorded there
as a generator gap did not exist — see the RV12-4 correction later in this document.

## Objective

Make the final, explicit public TypeScript declarations, JavaScript runtime behavior, field
semantics, result grammar, errors, generated documentation, MCP schemas, and packed-package
experience describe one contract.

Phase 3A already settled which operations use named requests and which positional protocols are
natural. Phase 3B.N settles their public vocabulary. Phase 3B does **not** mechanically object-wrap
more functions or reopen naming. It closes the different failure mode in which a good declaration
masks a runtime no-op, missing-field `NaN`, unreviewed answer shape, or misleading default.

## Reproduced seed defects

The first executable fixtures were reproduced under the baseline names:

- public `blackScholesPrice` and `black76Price` object kernels accept an unknown/misspelled key;
- omitting required `volatility` through JavaScript or `any` reaches arithmetic and returns `NaN`; and
- the corresponding facade path rejects the malformed request correctly.

After Phase 3B.N these identities become `blackScholesPrice`/`black76Price` and the field becomes
`volatility`; the defect and fixture identity remain the same. These are seed cases, not the scope.
The phase must identify every equivalent boundary systematically and prevent recurrence.

## Scope model: contract identities, not raw path count

The post-Wave-6 signature inventory contains 3,313 callable paths. That is an input to this phase,
not a claim that 3,313 handwritten validators are required.

The generated Phase 3B inventory must distinguish:

1. **Public path identity** — every import/namespace/member path a user can call.
2. **Implementation identity** — aliases that resolve to the same callable.
3. **Contract identity** — the unique input or result type plus its runtime policy and semantics.
4. **Validator identity** — the schema, builder, explicit guard, or boundary function that enforces
   that contract.

Aliases fan out evidence from one implementation/contract identity. Shared request types reuse one
semantic policy. The 3,313 path snapshot is the handoff baseline; Phase 3B.0 regenerates and binds
stable implementation/contract identities before remediation. The closeout reports both path
coverage and deduplicated implementation/contract work so neither number is misleading.

## Required generated and curated artifacts

Exact filenames may follow the existing `tools/manifest` conventions, but the responsibilities are
fixed:

| Artifact                                                                                     | Generated or curated                                    | Required contents                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public contract inventory                                                                    | Generated from built declarations and runtime manifests | Public paths, implementation identity, input/result contract identity, recursive fields, optionality, nullability, container/primitive types, aliases, and result role                                                                |
| Semantic field policy                                                                        | Human-curated, source-controlled                        | Meaning, unit/basis, default and source, null/omission meaning, accepted domain, error behavior, compatibility alias policy, and reviewed rationale                                                                                   |
| Runtime enforcement map                                                                      | Generated plus curated ownership                        | Object `closed`/`open`/`passthrough` policy, conventional scalar-mathematical disposition, validator identity, nested consumed fields, identity-scoped exception rationale, unchecked-private boundary (if any), and fixture identity |
| [Result-decision ledger](./phase-3b-decision-ledger.md#helper-quant-answer-decisions)        | Human-curated, shrink-to-zero                           | Settled upgrade or ratification plus implementation evidence for every helper quant answer                                                                                                                                            |
| [Positional-pair ledger](./phase-3b-decision-ledger.md#high-level-positional-pair-decisions) | Human-curated, exact-live-set                           | Settled rationale plus generated linkage for every retained high-level positional pair                                                                                                                                                |
| Conformance report                                                                           | Generated in CI                                         | Path and contract coverage, unresolved entries, alias fanout, exact errors, packed journeys, and performance/parity evidence                                                                                                          |

Generated artifacts discover structure. They may not invent units, financial meaning, safe defaults,
or a rationale for an API decision.

## Ordered implementation

### 3B.0 — Post-Wave-6 baseline and inventory design

- [x] Verify Phase 3B.N is closed: 42,476 naming identities, 0 unresolved, gated in CI; the packed
      consumer proves the final package/MCP names and every removed alias has executable evidence.
- [x] Build every public declaration and regenerate runtime/signature manifests after all Wave 6
      and naming-normalization checkboxes are closed.
- [x] Generate the initial contract-identity graph and report path, implementation, input-contract,
      result-contract, and validator counts separately — `tools/manifest/contract-inventory.ts` →
      `public-contracts.json`: 7,863 paths / 2,683 implementations / 1,553 input
      contracts / 1,926 result contracts / 384 validator identities (refreshed after the 2026-08-02
      defect-fix wave, which added validators and two fixed-income deep entrypoints, again after
      3B.1a's snapshot reader, and again when intersections were recognized as objects — 996 → 1,034
      input contracts, none of them new API: a parameter typed `A & B` had been filed `other`, so its
      contract was never recorded). These figures are
      GATED (`contract-conformance.test.ts`) — the first version of this checklist went stale within one
      commit, which is the same ungated-prose rot the naming closeout was criticised for.
- [x] Freeze stable IDs and alias/identity rules before package remediation begins. Implementation
      identity moved from `<file>:<charOffset>` to `<file>#<nameChain>` (ledger C02): an edit that
      shifts every declaration in a file changes 0 of the 6,612 identities present when that was
      measured — dated evidence about the identity scheme, not a live path count.
- [x] Author exact red fixtures as DATA (`SEED_FIXTURES` in `tools/manifest/contract-policy.ts`),
      re-verified at this head: `blackScholesPrice` and `black76Price` return `NaN` for a missing
      field and silently ignore an unknown key, while the facade rejects both. The inventory found
      four more of the same class OUTSIDE options pricing — `formatMoney` → `"$NaN"`, `formatPercent`
      → `"NaN%"`, `selectQuotePrice` → `undefined`, `formatOccSymbol` → an UNTYPED throw — which is
      the spec's own point that the seed defects were never the scope. No executable gate is
      committed; those land atomically with the 3B.1 fixes.
- [x] Bind the settled decision ledger to the regenerated helper-answer and high-level
      positional-pair sets. `public-contracts.json` now carries both populations under `ledgers`,
      recomputed from the live surface: **36 helper paths** (exactly the handoff baseline, which is how
      we know the definition matches) and **21 pair paths**, not the handoff 33 — Phase 3A and 3B.N
      already migrated twelve pairs to named requests, and the generated set governs.
- [x] Bind C20 before generating enforcement: validation scope follows contract shape, not package
      tier. `contract-policy.ts` derives a `boundaryKind` structurally, so nothing is excluded by
      package or tier — `core` (10) and `math` (38) are on the must-enforce list, positional scalar
      mathematics is a distinct `inputShape` (**1,305 paths** as committed; the 687 here was measured at
      488fbd7a against a 3,313-path surface and never refreshed — and the two package counts beside it
      reproduce under no definition I could construct, so treat all three as UNGATED and re-derive
      before using them), and `CONTRACT_EXCEPTIONS` is empty and
      requires an identity plus a rationale naming the enforcing boundary.
- [x] Prove inventory determinism and drift detection in CI —
      `tools/manifest/contract-conformance.test.ts` (11 gates: drift, determinism, no positional
      identity, count consistency, guard-convention drift, auditable delegation, C20 exclusions).

**Commit boundary:** inventory generator, schemas, committed baseline, drift test, and recorded seed
fixture IDs only. Do not mix broad package migrations into the inventory-design commit.

### 3B.0 — closure record

3B.0 MEASUREMENT IS **CLOSED** — the status block at the top of this file is the authority. The R-rows
below are the durable structural-work record. Every 3B.0 validity condition is closed; R14 remains
unstruck only because it is explicitly assigned to 3B.2 per-package workload accounting and does not
affect the honesty of a 3B.0 verdict. The inventory is trustworthy about **paths, identities,
determinism, boundary classification, and semantic depth**, and enforcement is **measured** rather
than inferred.

Numbers inside a CLOSED row are evidence as of the commit that closed it, and are dated where they
could be mistaken for current. They are deliberately not refreshed: chasing them on every artifact
regeneration turns a historical record into an ungated dashboard, which is the rot this phase keeps
having to fix rather than a cure for it. Live figures are in the header, and the header is gated.

| #       | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Size   | Blocks                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------- |
| R14     | **Runtime-callable identity.** `implementationId` is a declaration TEMPLATE identity (`<file>.d.ts#<nameChain>`), not a runtime callable — 8 such ids cover 710 runtime function objects. This was a STILL-OWED clause inside R10, a row marked DONE, which is how the artifact came to publish `defectiveImplementations: 596` under a name that reads as a workload. The metric is now split into `defectiveDeclarationTemplates` (what a source EDIT touches) and `defectiveMeasurementTargets` (what a VERDICT flip requires), so the number no longer lies — but the underlying identity is still template-level. Resolving it means giving each runtime function object its own identity, which is what lets a per-package migration report true progress. NOT a 3B.0 blocker: 3B.0 measures, and the measurement is honest about what it counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Medium | 3B.2 per-package workload accounting              |
| ~~R7~~  | ~~Recursive contract depth~~ — **DONE**: `contract-fields.ts` walks 945 contracts with the checker; `omit-required` / `wrong-type` convict when decided against a declaration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —      | —                                                 |
| ~~R8~~  | ~~Canonical MCP inventory~~ — **DONE**: `toJSONSchema()` for all 23 tools with recursive schemas, hashes, required lists and `additionalProperties`; 7 measured by payload probe, 0 defective                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —      | —                                                 |
| ~~R9~~  | ~~src↔dist skew~~ — **CLOSED**: not a resolution mystery; the inheritance key was wrong. Rekeyed on the resolved function object; the gate now demands exactly 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —      | —                                                 |
| ~~R5~~  | ~~Naming tracker~~ — **DONE**: all eleven `3B.N8-DOCS` children closed. `docs-inventory.ts` classifies 141 surfaces under a two-rule policy; `generated-docs.ts` declares 37 generated surfaces; the MCP guide's wire identities and the bundle table are gated against the live server and the enforced budgets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —      | —                                                 |
| ~~R10~~ | ~~Identity repair~~ — **DONE**: exposure identities split when declarations differ (35 entrypoint-qualified ids; `totalfinance:skew` no longer collapses a two-argument series function and a one-argument object request). Contract identity is now the resolved DECLARATION — `<source file>#<Name>` — recorded per parameter and used as the join key, so 3,620 of 3,695 field-tree joins are exact. `atr` resolves `bars.d.ts#PeriodParameters` (period OPTIONAL) and `sma` resolves `moving-averages.d.ts#PeriodParameters` (period REQUIRED), matching the runtime: `atr(bars, {})` is accepted, `sma(series, {})` throws `input.missing_field`. Only repository declarations get an identity — the first version emitted absolute `node_modules/typescript@5.9.3/lib.es5.d.ts#Array` paths, ledger C02 arriving by a new route.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Small  | —                                                 |
| ~~R11~~ | **Honest measurement semantics.** DONE. The three validity gaps are closed: measurement is CANONICAL per (function object, contract) so a stateful target is probed once and its other names inherit — `stoch`/`stochastic` and `bb`/`bbands` now agree, and the 100 `enforced` verdicts that disappeared were second measurements against an already-probed target, the `register` false positive at scale (`blackScholes.price` ACCEPTS omitting the required `dividendYield`; the scoped path said so and the umbrella said `enforced`). Discriminated-union branches are fully EXPANDED — 66 union nodes, 185 branches — and the retry walks them, so a boundary whose first branch the harness cannot build now tries the next (`bonds.amortizing` gets `{type:'straight'}` on attempt 0 and `{type:'annuity'}` on attempt 1). Baselines are validated STATICALLY against their declaration before the boundary is called, which is what makes `baseline-rejected` mean something: zero synthesized requests are incomplete, so all 93 rejections (as measured at `25545b78`, when this row closed) are contracts refusing WELL-FORMED input rather than the harness handing them malformed input. An async boundary no longer scores mutations nobody awaited — a returned thenable is `async-result-unobserved`, an honest gap instead of a pass on evidence never collected. `partial` verdict; a PER-BOUNDARY budget in `measure-supervisor.ts` (a `setTimeout` cannot interrupt synchronous JavaScript, so only another process can observe a hang); recursive DEPTH — every DECLARED field by dotted path, declared optionals supplied with a forbidden type, `wrong-type` derived from the declared kind. CALLBACK SYNTHESIS IS ON: the standing conclusion that it needed per-boundary isolation was wrong, it needed a stub that is not a constant. Arity decides — a nullary numeric callback is an RNG and must vary per call (`while (u1 === 0)` exits no other way); an n-ary one is an integrand and must be SMOOTH (a per-call random value is read as roughness and subdivided). Zero hangs. Enabling it found a real library defect: `adaptiveSimpsonSafe(f, NaN, 1)` never returned, because a NaN error estimate makes the tolerance exit unreachable and the only remaining exit is 2^50-node depth exhaustion — fixed at source with `ensureFinite` on both bounds and a budget on WORK rather than tree height. HISTORICAL, kept because the reasoning is the useful part: (1) STATE ISOLATION — `stoch` and `stochastic` are ONE function object with ONE contract and land on different verdicts, because two probe batches against a stateful indicator are not independent. The evidence-drift gate recorded this as a permutation while the skew lasted, which made it visible without making it sound; that allowance is now removed and the gate is exact, because canonical measurement per (function object, contract) took the cross-name disagreement away: a measurement whose answer depends on what ran before it cannot ground 3B.1. The isolated-process generation added for the determinism check is the mechanism; applying it per BOUNDARY is the work. (2) UNION BRANCHES are labelled (`branches`) but only the first is expanded, so a contract's other branches are unmeasured rather than measured-and-passed. (3) ASYNC PROTOCOLS — `collectAsync` and `streamAsync` receive contradictory unmeasured reasons across aliases, which means the harness does not yet await what it calls | Large  | Whether a verdict means the contract was enforced |
| ~~R12~~ | **Receiver and protocol coverage.** DONE. Instance methods are measured through a receiver that is CONSTRUCTED or PRODUCED — a receiver can be returned as well as built, and 9 members (`Bond#accrued`, `HullWhiteModel#caplet`, `YieldCurve#addSpread`) were filed `external-callback-contract` — "no implementation here to probe" — when the library implements every one; they landed there because the reason was chosen by whether the OWNER resolves as a runtime export, and a `Bond` is returned by `bonds.fixedRate(...)`, not exported. A FRESH instance per call, because these objects mutate. Producers are validated against `contractMembers`, newly published by the inventory, so a factory whose output lacks the contract's required members is refused. `receiver-unresolved` 4 → 7, `external-callback-contract` → 9 (both as measured at `25545b78`, when this row closed). The remaining 9 are genuine: their contract is enforced where the library INVOKES them, which is a different measurement, not a missing one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Medium | Whether an instance method can be measured at all |
| ~~R13~~ | ~~Complete drift gates~~ — **DONE**: enforcement drift compares the full evidence shape (failures, advisories, undecided dimensions, unmeasured reasons, key policies), MCP drift compares schema HASHES rather than tool ids, and `pnpm artifacts:update` regenerates every dependent artifact in dependency order — deliberately excluding `manifest:update`, which wipes hand curation, with a gate asserting the exclusion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —      | —                                                 |

**R7 is DONE, and it changed what a verdict means.** `contract-fields.ts` asks the TypeScript checker for
each contract's recursive shape — field types, requiredness, nullability, string-literal unions, array
element contracts, nested objects — for 945 named contracts, deterministically. `omit-required` now fires
only on fields the contract declares REQUIRED, and both it and `wrong-type` carry a `declared` flag; only
a declared result may convict. That closes the gap that had `formatMoney` reading `unmeasured` despite a
hand-proven defect.

Promoting those two mutations surfaced 209 new declared-contract defects. One example, verified by hand
against its own fixture: `cdsParSpread` returns the same answer with and without `spread`, a field its
type declares required and its implementation ignores entirely because it COMPUTES the par spread.
Whether the fix is to make the field optional or to reject it is a 3B.1 decision; the inventory's job was
to find it.

**Container mutations stay ADVISORY, and that is a correction of my own over-reach.** Promoting them
alongside convicted 1,734 paths on `empty-series` — and `sma([], { period: 5 })` returns `[]`, which is
CORRECT for an aligned-output series API. Whether an empty series, a `NaN` element or a wrong element
type should throw is a per-API judgement about documented IEEE behaviour, and the generator is forbidden
from inventing it. Convicting there would have manufactured two thousand defects out of documented
behaviour: the same error as counting a reachable guard as enforcement, reached from the opposite
direction.

**R8 is DONE.** All 23 tool contracts now come from `schema.toJSONSchema()` — public API, which is why the
private-slot guessing was unnecessary as well as wrong. Each carries its recursive input and output JSON
Schema, a content hash, the declared `required` list, and `additionalProperties`. The tool this was filed
against, `totalfinance.option.implied_volatility`, went from an EMPTY input list to eleven properties with five
required — `method` and `fallback`, which decide which solver runs and what happens when it fails, had been
entirely invisible.

Measured as well as recorded: each tool is called with a minimal payload built from its own `required`
set, and then with an unknown key and with required fields removed. **7 of 23 measured, 0 defective** —
every measurable MCP tool rejects both mutations with a typed error, and `additionalProperties: false` is
Law 12 stated in JSON Schema. That contrasts sharply with the library surface (424 defective) and is worth
knowing: the agent-facing boundary is the better-guarded one.

The 16 unmeasured are honest. Some declare no `required` list; others have contracts JSON Schema cannot
express — `totalfinance.volatility.expected_move` needs EITHER `straddlePrice` OR both `impliedVolatility` and
a time, an XOR that no `required` array can state. A payload built from `required` alone cannot satisfy
those, and the baseline-must-succeed rule then correctly declines to measure rather than inventing a
verdict.

**R9 is CLOSED, and it was not what it looked like.** Four alias pairs measuring differently under vitest
source resolution and tsx dist resolution suggested a contract with two behaviours. It was neither
resolution nor ordering — it was the inheritance key:

    export const difference = lagFacade('diff', 'diff');
    export const change = difference;   // the SAME function, a different name

`change` and `difference` are one object, but their declaration identities are `#change` and
`#difference`, so an implementation-string key never linked them. Whichever happened to be probeable got
measured and the other stayed `unmeasured` — and which one that was fell out of module resolution.

Inheritance is now keyed on the RESOLVED FUNCTION OBJECT, which needs no heuristic: same function, same
behaviour under mutation, necessarily. Both earlier keys were wrong in opposite directions — the raw
implementation string OVER-linked (217 unrelated indicators sharing one `makeIndicator` declaration), and
string-plus-`===` UNDER-linked (it only compared functions whose strings already matched). The skew went
to zero and the gate now demands exactly that; coverage improved as a side effect, 1,260 unmeasured to
1,011.

**R6 is CLOSED, and the answer shrank R7.** A review of `926ef874` reported 67 multi-overload public
paths against this inventory's 3, which would have meant overloads were being collapsed and the probe's
first-overload limitation was much larger than it looked. Settled three independent ways:

- the contract inventory: 3 paths resolving to **1** implementation (`cdlPattern`, two signatures);
- a textual scan of every built `.d.ts` for repeated `declare function` overload sets: **0**;
- a fresh `ts.Program` over every root entrypoint, asking the checker for call-signature counts: **1**.

They agree. Overloads in this library are not expressed as `declare function` repeats, so "the probe
uses only the first overload" affects exactly one implementation rather than sixty-seven. A gate holds
that count so that if genuine overloads appear, the limitation becomes visible instead of remaining a
comfortable assumption.

**HISTORICAL (this section records why 3B.0 reopened in July 2026; it closed at `25545b78`, with the
hosted matrix green on that exact SHA — see the header for current status).** The reasoning is kept
because the failure mode it describes is the reusable part.

**3B.0 REMAINED OPEN at the time of writing, and the revision before it was wrong to imply otherwise.** Closing
R5 closed the last row of the _documentation_ work list; it did not make the inventory trustworthy
enough to drive 3B.1. An external review found three identity and semantics defects that a
count-based reading of these artifacts would have hidden, and two of them were introduced by the very
commit that claimed to be fixing this class of error:

- **Exposure identities collapsed different functions.** `upsertCallable` merged on `<package>:<path>`
  and appended entrypoints, which assumes the same name from two subpaths is the same callable. For 17
  umbrella exposures it is not: `totalfinance/technical-analysis` exports a two-argument series `skew` and
  `totalfinance/volatility` a one-argument object-request `skew`. The merged record named the volatility
  declaration and carried technical-analysis probe evidence. `covariance` collapsed three ways.
- **Contract identities collapsed homonymous types.** `<package>:<BareName>`, first one wins. The same
  `atr` function measured `enforced` through `@totalfinance/technical-analysis` and `defective` through
  `totalfinance`, on an `omit-required` for a field one of the two trees marks optional. The root cause is
  a LIBRARY defect: `@totalfinance/technical-analysis` declares `PeriodParameters` in ten modules, and
  `bars.ts` (which ATR uses) makes `period` optional while the other nine make it required.
- **`enforced` did not mean the declared contract was enforced.** It was awarded whenever no
  AUTHORITATIVE mutation failed, which is not the same thing: 1,851 of 2,881 "enforced" paths had
  accepted at least one advisory mutation and 1,544 had accepted a wrong element type, a non-finite
  element, or a ragged matrix. `@totalfinance/math:determinant` declares a matrix, was handed a
  one-dimensional array, accepted it, and was called enforced.

**Coverage as of this commit:** 4,328 candidate boundaries. R7 did close part of the gap exactly as
predicted, once synthesis was taught to read the field trees it had been recording and ignoring.

**`unmeasured` now says WHY, and that changed what the number means.** It was one bucket of 1,011, which
reads as 1,011 things the harness failed to check. It is four different things:

| reason                | count | actionable?                                                                       |
| --------------------- | ----: | --------------------------------------------------------------------------------- |
| `no-input`            |   448 | yes — no fixture, and synthesis could not build an argument list                  |
| `baseline-rejected`   |   248 | yes — an input was built and the contract rejected it, so the guess was wrong     |
| `not-callable`        |    70 | **no** — a declared FIELD with nothing to call; no synthesis will ever measure it |
| `no-mutable-argument` |    12 | partly — the baseline held no object to mutate                                    |

70 of those paths were never measurable, and reporting them inside one undifferentiated number
overstated the outstanding work by exactly that much. Same discipline as splitting `guardReachability`
from measured enforcement: a number nobody can act on is worth less than a smaller number that says
what to do.

**Synthesis now builds from the declared field trees.** `contract-fields.ts` had been recording
recursive shapes for 945 contracts and `contract-synthesis.ts` never read them — it populated object
arguments from a curated name table alone, so `cir` went unmeasured for want of `{ a, b, r0, sigma }`,
none of which is vocabulary anyone would think to curate. Reading the tree, walking every declared
entrypoint rather than only `dist/index.d.ts` (945 → 1,980 contracts with a known shape), and allowing
generic values for unconstrained strings and callbacks took unmeasured from 1,011 to 778 and — by
measuring paths that had never been measured — the known defect count from 466 to 669.

The baseline-must-succeed rule is what makes all of that safe: a wrong guess costs coverage and can
never produce a verdict. Every new defect class was verified by hand before being trusted —
`defineCalendar` accepts a calendar with no `timezone` and no `name`, both declared required, and
returns an object missing them; `plausibilityWarnings` accepts `volatility: NaN` and reports no
warnings, which is the one thing a plausibility check exists not to do.

**A defect class the inventory could not previously see: unnameable parameter types.** The graph
recorded what every parameter's type IS and never asked whether a consumer can NAME it. 73 object
parameters fail that question, split because the fixes differ:

- **31 `unreachable`** — exported by no package at all. `compareEngines(input: CompareEnginesInput)` is
  public while its input type is not; the options index re-exports nine sibling types from the same
  module and omits that one. `BaseSpecification` and `Rule` are not even declared with `export`, so no
  re-export could reach them. A consumer can call the function and cannot declare its argument.
- **42 `foreign`** — exported by a different package than the one demanding them (`@totalfinance/options`
  takes an `OptionQuote` that only `@totalfinance/core` exports). Importable, but undiscoverable from the
  call site.

Recorded in `public-contracts.json` under `nameability` and held by a ratchet. The repair belongs to
3B.2, which migrates packages in dependency order and re-packs a tarball per commit; inventing a
sweeping cross-package export change here would break that ordering. The inventory's job was to find it.

### 3B.1 — Runtime enforcement foundation

#### 3B.1a — The persistence envelope — DONE

The first cluster, and the one chosen first because it is the only place in the library where the
input is genuinely untrusted: a snapshot arrives from storage or across a wire, not from a programmer
who mistyped a field. 134 defective boundaries, 134 distinct implementations, one shared cause.

- [x] `readSnapshot(snapshot, kind)` — one door into a stored snapshot, replacing `snapshotState`,
      which validated the envelope and then handed back raw state for unchecked casting. It checks
      the closed envelope, the schema version, and the INDICATOR IDENTITY, then returns a
      `SnapshotState` whose accessors check each field. All 194 restorers converted; 766 `as` casts
      and 58 unchecked `Object.assign` reads are gone. `SnapshotState` is a type-only export — a
      caller names it, never constructs it, because a public constructor is a door past the guard.
- [x] The identity guard is the headline. It existed only on the FACADE; the static class restorers
      are public too, and had none of it — so `AtrStream.fromJSON(emaSnapshot)` produced an ATR
      stream seeded with EMA numbers, no error, no NaN. A restorer that serves a FAMILY passes the
      family list, and the list is compiler-enforced rather than restated: typing `rollingFacade`'s
      parameter by it immediately found three indicators (`rescale`, `rollingQuantile`, `winsorize`)
      that the hand-written list had missed.
- [x] **Schema version 3 — non-finite numbers are ENCODED.** The first reader simply refused `NaN`.
      Measuring that decision against seven degenerate datasets refuted it: fed a zero price series,
      `realizedVolatility` fills its window with NaN log-returns from VALID input, and 38 distinct
      state paths across the 335 indicators do the same. Refusing NaN would refuse to restore correct
      streams — but TOLERATING it leaves the contract unenforceable, since a NaN from arithmetic and a
      NaN from a damaged file are the same value. So `snapshotOf` encodes them (`{ nonFinite: 'NaN' }`)
      and `readSnapshot` decodes once at the door and refuses any RAW one. This also fixed a live bug:
      `JSON.stringify(NaN)` is `null`, so persisting any of those 38 paths silently replaced the NaNs
      with nulls, which then read as zero. `divergence` carried three hand-rolled revival helpers for
      its own instance of this; they are deleted.
- [x] Structural gates so the class cannot return: every restorer enters through `readSnapshot` and
      casts nothing; every `toJSON` builds its envelope with `snapshotOf`; and no snapshot carries a
      field its restorer never reads. The last one found `CvdAggregator` serializing a bare
      `Record<string, unknown>` with no kind and no version — the only serializer in the package
      outside the envelope law — and six fields written and never read back (`DpoStream`'s `shift`,
      recomputed from `period`, was convicted by the harness independently).
- [x] Measured result: the 134 defective persistence boundaries are **0** — 30 `enforced`, 99
      `partial`, 5 `unmeasured`. `partial` is the honest verdict for most: the only mutation they
      still accept is omitting `state.value`, the output cache, which a snapshot may legitimately
      lack. Package-wide `@totalfinance/technical-analysis` defective 440 → 306; library-wide 1,763 →
      1,629 across 597 distinct implementations.
- [x] Costs, recorded rather than buried: `@totalfinance/technical-analysis/rsi` 5.0 → 6.6 KB gzip and
      the umbrella 321.8 → 325.3 KB (budgets 6 → 7 and 325 → 327; nearly all message strings, import
      graph unchanged, and the umbrella pays the reader once because it is one shared module), and
      `unmeasured` 211 → 215 — five restorers now refuse the harness's synthesized snapshot (a
      fractional `period`, an envelope with no `kind`), which is the guard working and the
      synthesizer's producer selection to fix next.

- [x] **Correction (review R1).** The published guarantee — "a raw non-finite anywhere in state is
      refused" — was false in one corner, and the wording was wrong rather than merely imprecise.
      `isEnvelope` recognised a nested envelope by a string `kind` and a numeric `schemaVersion`
      alone, so `decodeTree` skipped anything wearing that shape and a persisted record like
      `{ kind: 'engulfing', schemaVersion: 2, high: NaN }` carried a raw NaN straight through.
      Recognition now requires the COMPLETE three-key envelope and nothing besides — exactly what
      `snapshotOf` writes — with three regressions covering the look-alike, the header without
      `state`, and a real nested envelope still being left to its own reader. The 134 boundaries were
      enforced throughout; what needed repair was the universality of the claim.

Consumer documentation: [`docs/guides/ta-snapshots.md`](../guides/ta-snapshots.md).

#### Review-correction wave (2026-08-03) — DONE

An external review of `3cf2f17e` returned six findings. All six reproduced; all six are closed, and
each one carries the gate that would have caught it, because five of the six passed a green hosted CI
of 8,985 tests. A defect that survives the suite is also a statement about the suite.

- [x] **P1 — a partial OCO bracket could exit more shares than the bracket owns.** `broker.ts` sized
      siblings off `Math.abs(position(symbol).quantity)`, which equals the bracket only when the
      bracket IS the whole position. Layer a 10-share bracket over a 100-share holding, throttle
      fills to 5/bar, and it exited 15 and left the holding at 95. The group's capacity — the
      parent's filled quantity — is now recorded when the bracket is born, and siblings resize
      against `min(capacity − exited, held)`. Fixing it surfaced an adjacent case the review did not
      name: a bracket whose position the strategy had already closed by hand still fired, because a
      FULL fill never reaches the resize path; bracket fills are now capped by what the bracket owns
      and the group cancels when that reaches zero. Four tests: long add-on, short add-on,
      overlapping brackets, already-closed.
- [x] **P1 — public registry metadata was live and mutable.** `getIndicator('rsi').parameters.push(…)`
      turned Law 12 off for the entire process, because `register` bound the CALLER's array into the
      facade's runtime allowlist and the accessors handed that same array back. Entries are now
      cloned and deeply frozen at registration and the facade is bound from the frozen copy; nine
      tests cover `getIndicator`, `listIndicators`, `describeIndicator`, `searchIndicators`, the MCP
      discovery path, direct execution, and a caller mutating their own array after registering.
- [x] **P2 — the fluent TA pipeline was not treated as a boundary.** `features(bars).rsi('close')`
      threw a raw `TypeError` from the pipeline while `rsi(closes)` defaults to 14 — the wrapper was
      stricter than the thing it wrapped. Methods with universal defaults (`rsi`, `atr`, `bbands`,
      `macd`) now permit omission; the rest call the indicator FIRST so its own teaching error is
      what surfaces. `{ az: 'fast' }` was silently ignored and `{ as: '' }` produced a column named
      `""`; alias options are now a closed request with a non-empty value. The generated column base
      The generated column base `vol_` became `rolling_volatility_` — `vol` is forbidden across the
      library — with an AST gate over every column template, since the naming inventory walks
      declared identities and can never see a runtime string. That name took two passes: the first
      correction used the indicator's EXPORT name (`rollingVolatility_close_5`) to keep the column
      mechanically parseable back into (indicator, field, parameter), since snake-casing a
      multi-word indicator makes `_` ambiguous. The priority was inverted. A column name is DATA —
      it lands in a DataFrame, a parquet file, a warehouse table, where Postgres folds unquoted
      identifiers to lowercase and Snowflake folds them to uppercase — so one convention across the
      whole string beats a parse nobody asked for, and provenance wanted mechanically should be
      exposed structurally rather than recovered by regexing a string. Every peer library that emits
      feature columns (pandas-ta, tsfresh, dbt) is snake_case. The gate now enforces snake_case
      directly, which matters because 229 of this package's function exports are camelCase: the
      moment `stochRsi` joins the fluent surface, the export name written straight into a template
      reintroduces the mix.
- [x] **P2 — the snapshot reader's raw-NaN guarantee had a bypass.** See the 3B.1a correction above.
- [x] **P2 — MCP injected the seed after schema validation.** A tool declaring `seed: number().integer()`
      accepted and echoed a `defaultSeed` of 1.5. `defaultSeed` (and `maxInputBytes`, `deadlineMs`)
      are validated at CONSTRUCTION — a misconfigured server fails when it starts, not on the call
      that trips over it — and the effective request is re-parsed after injection, so a tool's own
      seed constraints stay authoritative.
- [x] **P3 — the controlling trackers contradicted the artifact.** The status header advertised
      `924 / 1,444 / 1,763 / 211 of 4,342` against a live `966 / 1,543 / 1,630 / 208 of 4,347`, and
      carried a second, different `defective` two paragraphs down. Refreshed — and now GATED: the
      header's five counts and every `unmeasuredByReason` bucket are compared against
      `public-enforcement.json`, so this specific rot cannot recur. The paragraph declaring "3B.0
      REMAINS OPEN" is marked HISTORICAL rather than deleted; it records why 3B.0 reopened, which is
      the reusable part. `implementation-order.md` and the naming closeout table were refreshed from
      the generated artifacts in the same pass.

One self-inflicted defect was found and fixed in the same wave: 3B.1a's registry-wide envelope suite
emitted 1,675 individual test cases from one file — every one a reporter round-trip — which was enough
to time out the runner's RPC channel on a loaded machine while all 9,022 assertions passed. The five
properties are now asserted across the registry with offender LISTS. Coverage is identical, a failure
names every indicator that broke rather than the first, and `pnpm run ci` is green rather than
green-with-two-unhandled-errors.

#### Gate closeout (2026-08-04) — the tolerance that outlived its cause — DONE

The enforcement drift gate carried two deliberate allowances: verdicts had to match within FOUR
records, and evidence over the drifting ids only had to be a PERMUTATION. Both were honestly earned.
Generation ran in-process under vitest, where `@totalfinance/*` resolves to SOURCE, while the committed
artifact was generated under tsx, which resolves to DIST — and a family of TA transforms are thin
wrappers over one stateful runtime function, so the two graphs really did disagree about which member
of a pair carried the evidence.

Then 3B.0 moved generation into a subprocess to fix heap exhaustion, and that subprocess resolves to
dist — the same graph the artifact comes from. **One module graph on both sides; the cause was gone
and the allowances stayed.** Nothing announced it, because a tolerance that stops being needed does
not fail — it just quietly widens into room for something else. What remained was a gate that
permitted four genuine verdict regressions and unlimited movement of evidence between paths, with
nothing left to excuse either.

Both are now exact — `[]` and `[]` — and both were verified to FIRE on what they now claim to catch:
a single verdict flip with the summary adjusted to stay self-consistent (so only the verdict gate can
be the one that trips), and a swap of `failures` between two `defective` records, which leaves every
verdict, the summary, and the evidence multiset untouched. That second case is precisely what the
permutation allowance forgave, and it is now caught. Fresh-vs-committed was measured byte-identical
before the bounds were tightened, so exactness costs nothing today.

**The reusable part: an allowance must be re-examined when the thing it forgave is fixed, and a fix
in one place removes tolerances in another.** The subprocess change and the tolerance lived in
different files with no link between them; only tracing the tolerance's stated cause found that it
had already been eliminated. Every remaining exemption should be readable back to a live cause — the
global-state exemption below is now checked that way, by asserting each boundary it excuses is
actually measured on the first pass.

Applying that rather than only recording it, every numeric bound in the gate chain was compared
against the value it guards. Three had drifted off it, one of them the same disease:

| Bound                          | Was   | Measured | Now                                                                                                                                                                              |
| ------------------------------ | ----- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TypeError` rejections         | ≤ 6   | **0**    | `toBe(0)` — R11 turned callback synthesis on and fixed the inline-type parser, which removed all six; the bound stayed, and its comment still called itself "deliberately tight" |
| `enforced`                     | ≥ 954 | **966**  | ≥ 966                                                                                                                                                                            |
| `unmeasured`                   | ≤ 215 | **208**  | ≤ 208                                                                                                                                                                            |
| `snapshot.unsupported_version` | ≤ 8   | **7**    | ≤ 7 — cause still live (the synthesizer picks a producer by TYPE, so a restorer can be handed a well-formed snapshot of the wrong `kind`)                                        |

The other five bounds — `baseline-rejected` 88 `receiver-unresolved` 4 `linalg.singular` 3,
`unnameableUnreachable` 31, `unnameableForeign` 42 — were already sitting on their measured values.
**A ratchet is re-seated whenever the number it guards improves, or it is a ratchet in name only**; a
closed tracker ROW stays dated, but the BOUND is a different object and tracks the artifact.

#### 3B.1b — The remaining clusters

- [x] Define one reusable contract for required object, exact closed keys, primitive/container type,
      finite numeric input, nested consumed fields, and discriminated-union branch validation.
      **DONE (2026-08-15): `validateClosedRequest` in `@totalfinance/core` + checker-generated specs.**
      The architecture, settled after the statistics review's instruction ("implement
      checker-derived per-branch keys and the reusable shared validator contract; do not
      hand-author a subtype table"):

      - **Specs are PROJECTED, never authored.** `pnpm validation:update`
        (`tools/manifest/validation-specs.ts`) reads the checker-built contract inventory and
        emits per-package generated modules (`packages/<pkg>/src/generated/validation-specs.ts`,
        deliberately absent from every exports map), deduped by contract identity and keyed by
        `boundary#argumentIndex`. MEMBERSHIP is curated in `validation-roster.ts` so generated
        bytes stay proportional to the migrated surface; CONTENT is projection. The drift gate
        (`validation-specs.test.ts`) demands byte equality against a fresh prettier-formatted
        emission and plants the over-closure regression: a spec that loses the barrier
        intersection's inline `type`/`barrierType` — the exact defect the spec history warned a
        closed key list would commit — fails.
      - **The validator walks the spec with the exact code per mistake** (C11): unknown key with
        did-you-mean, missing required with the hand-authored worked example (C03: a generator may
        not invent financial values — teaching stays at the call site), null-is-not-omission,
        numeric/enum/boolean/string/array/callback ladders, nested dotted paths, and
        discriminated-union resolution that is DISCRIMINANT-FIRST (an undeclared discriminant
        teaches against the whole declared domain — the `phi: {}` class cannot fall through) with
        structural required-key selection for undiscriminated arms (`Amortization`'s
        `{ principalByPeriod }`). Per-spec key indexes are cached in a WeakMap; calls allocate
        nothing. Proven at the definition in `packages/core/test/validation.test.ts`.
      - **Curated IEEE bounds** (C03: generate structure, curate meaning):
        `NON_FINITE_BOUND_FIELDS` in the roster marks the five fields whose documented domain
        includes ±Infinity as the spelled "unbounded" (`CliquetInput.localCap` — doc: "default
        `+∞`"; `globalFloor`/`globalCap`; `NapoleonInput.globalFloor` — the MC exact-identity test
        passes `-Infinity`). NaN stays rejected everywhere; `localFloor` stays finite (its resolver
        demands ≥ −1); boundaries sharing a contract must agree or generation throws.

- [x] Preserve Law 12: closed requests reject unknowns with did-you-mean teaching errors; open
      structural artifacts validate consumed fields while preserving decoration; true passthrough
      remains rare and explicit. CLOSED 2026-08-17 at defective zero: the `unknown-key` and
      `null-when-nonnullable` populations both read ZERO in `public-enforcement.json`; every
      open-policy boundary is a deliberate curated row with its rationale beside it.

      **Scoped 2026-08-05; re-measured 2026-08-15 at the Stream-constructor closure.** 360 records
      carry an `unknown-key` failure; the `totalfinance` umbrella aliases close for free with
      their source package, leaving **ZERO boundaries — the ledger is empty**. Largest remaining
      clusters: `technical-analysis/momentum-ext` 14, `options/heston` 11,
      `technical-analysis/transforms` 11, `math/solvers` 10, `technical-analysis/oscillators` 9,
      `technical-analysis/volatility` 9, `options/engines` 8. The `null-when-nonnullable`
      population stands at **ZERO**.

      **Twenty-seventh wave CLOSED (2026-08-17): DEFECTIVE ZERO.** The ledger that opened this
      phase at 2,694 is empty — every path is `enforced`, honestly `partial` with its open
      dimension named, or `unmeasured` with its reason. Three kinds of close finished it. RUNTIME:
      the second-stratum ladders across eight packages (the IV family's options-side guards — the
      prior wave laddered the INPUT object, where key closure already rejected those fields, while
      the options-side coalesces stayed live; both Monte-Carlo doors; the broker's
      underlying/style/type/split guards; `eventDriven`'s validation MOVED from after the
      simulation loop to before the first bar, where `corporateActions: 42` had crashed mid-run as
      a raw `.get is not a function`; `swapXva`'s parameters; the bond twins wired into the shared
      analytics ladder plus its context-member rungs; the calendar builders; the MCP server's
      construction guards; `resolveSigns`'s exhaustive-switch hole, where a runtime value outside
      the union fell off the end and computed every exposure against `undefined` signs), plus the
      backtest package's first GENERATED spec module — `optionsBacktest`'s 7-arm EntryRule union
      walked from the declaration, with `chains` curated `unchecked` because it is declared
      ITERABLE and the projector's 'array' kind would reject a legal generator — and `vectorized`'s
      model/signal ladders. MEASUREMENT: the probe learned unions. Its wrong-type value for a
      `string | number` parameter was a member of the other branch — a probe that cannot fail —
      which had convicted three term-structure heads and `explainPosition` for accepting declared
      values; and omission of a field required by ONE arm but not EVERY arm no longer convicts
      (`rawGreeksFromDisplay(greeks: Greeks | ExtendedGreeks)`: deleting `charm` re-narrows to a
      complete Greeks, and ten convictions described the union working). The walker's own
      discriminant selection learned the mirror lesson: an OPTIONAL enum shared by every arm
      (`price?: 'bid' | …`) is never a discriminant, or every legal call omitting it is refused.
      CURATION: umbrella spellings of curated boundary policies get their own deliberate rows,
      because the propagation seed rightly refuses to broadcast a curated row by implementation
      identity. One runtime defect each in risk (`lambda` — the ONE extended greek declared
      `number | null` was the one missing from the ladder) and strategy (an unparseable `asOf`
      taught on the sufficient-market path and was silently ignored on the degraded one).

      **Twenty-sixth wave CLOSED (2026-08-16): the coordinated tail sweep.** One wave, five
      packages, defective 102 → 68. The options pricing family ladders `engine: null` — it used
      to coalesce into the DEFAULT engine, so the caller believed THEIR engine priced — plus
      every boolean flag and numeric knob across seven heads (priceOption, impliedVolatility and
      its many-variant, americanOption's IV, americanExercise's boundaryPoints, priceMany,
      monteCarloPrice). The fixed-income fourth stratum lands: `fraValue`'s date/rate types,
      `generateSchedule`'s endOfMonth, `shortRateTree`'s REQUIRED model taught with a complete
      example call, `swapXva`'s optionType, and the shared bond-analytics option ladders that
      cover all four facade `.explain` companions. The broker closes `registerOption`'s
      specification — the allowlist read from the declaration after an `underlier` guess broke
      eighteen tests — and guards `submit`'s symbol. Strategy ladders its `premiums` source (the
      declared domain is `'model' | 'user'`, not the guessed `'given'`; the typechecker flagged
      the impossible comparison), the chain variant options, and `explainPosition`'s label.
      Structure's exposure and flow configs run their full ladders. unknown-key stands at SIX
      boundaries across five files; null-when-nonnullable at 22 across 13.

      **Twenty-fifth wave, second slice CLOSED (2026-08-16): the broker's method surface.**
      `submit` closes its order request — an `ocoGrup` typo silently UN-LINKED the bracket, the
      exact class the closed request exists to kill — and ladders every numeric leg;
      `processBar` guards its front and the `adjusted` flag; `registerOption` and
      `settleExpiries` guard their positionals; the options-backtest engine ladders its config
      (capital, rates, cost models, the assignment enum) pre-coalesce; `optionsTearSheet`
      refuses a hand-built result missing its assumptions; `tearSheet`'s `monteCarlo: null`
      stops coalescing through truthiness; `eventDriven`'s corporateActions must be the Map the
      lookup keys expect (`universe` domain read from the declaration after one wrong guess);
      and the per-tick model methods (`processBar`, `CostModel#commission`,
      `SlippageModel#fill`) carry curated open policies — decorated market data is the norm.

      **Twenty-fourth wave CLOSED (2026-08-16): the fixed-income model floor and the curated
      boundary-policy table.** The short-rate factories (`vasicek`, `g2pp`) close and ladder
      their parameters, both `discountBond` methods close their requests (G2pp's optional
      factor levels ladder when present), `shortRateTree` pre-coalesces its model enum,
      `generateSchedule` closes with a calendar object guard, the swap family's third stratum
      lands (`swaptionPrice` float legs, `forwardCmsRate`'s REQUIRED volatility, `fraValue`'s
      required start/end/fixedRate, `swapXva` conventions, ZCIS fields, `oasAnalytics` mirrors
      `callableBond`, `curveMetrics` bump/context), and the `priceMultiCurve` curation row that
      the draft had but the file didn't finally lands. New measurement vocabulary:
      `BOUNDARY_INPUT_POLICIES` — per-boundary curated policies for callables the exports map
      cannot name (`.explain` twins, interface-typed receiver methods) — with the propagation
      seed EXCLUDING curated rows, because a boundary-curated policy names one path, never a
      function identity: the first regeneration re-created the blanket explain-twin inheritance
      through the propagation channel (options 11 → 29 for one measurement cycle) and the
      exclusion sealed it.

      **Twenty-third wave, first slice CLOSED (2026-08-16): the pricing-facade artifacts.** The
      `market()` builder requires its spot and rate through the field ladder, `equityLattice`
      closes its options, the Monte-Carlo flags (`antithetic`/`brownianBridge`) run boolean
      ladders at the shared sampler core, and the price/implied-volatility family's
      `engine`/`contract`/`market` request fields are curated artifact-valued (an
      OptionPricingEngine carries capabilities, a contract carries OCC decoration, a market is
      the frozen builder artifact) — members advisory, requests closed.

      **Twenty-second wave CLOSED (2026-08-16): the core utilities answer for themselves.**
      `between(NaN, 0, 1)` used to answer false as if it had CHECKED; the formatters teach
      instead of rendering `$NaN` into a report; `warning` guards the public payload it builds;
      `plausibilityWarnings` closes; the calendar builders close their config and ladder the
      array-valued rules (`defineCalendar` delegates through `createRuleCalendar`, so ONE door
      covers both); `formatOccSymbol` keeps its documented parse→format round-trip — a first key
      closure broke the property test that pins it, and the parse artifact is policy `open`
      instead; `selectQuotePrice` distinguishes field-absent (the venue didn't publish) from
      field-null (a wrong-typed value headed for `(bid+ask)/2`); the volatility term heads and
      `prepareSlices` guard their positionals. The surface-lookup semantics of a garbage expiry
      STRING on the term heads remain the last question there — the surface's own teaching, next
      slice.

      **Twenty-first wave CLOSED (2026-08-16): crypto to ZERO, the options tail thins.** All
      twelve crypto boundaries ladder their optional conventions pre-coalesce (funding intervals,
      tolerances, coin yields, and the `side` enum — `{ side: null }` used to silently price the
      LONG leg), `black76PriceBounds` joins the kernel field-ladder discipline (no key closure —
      bound kernels compose), the parity family guards `source`/`outlierThreshold` at all its
      heads, the equity lattice pre-coalesces `steps`/`variant`, the two remaining batch heads
      close their columns, and the OCC contract inside `americanExercise`/`americanImpliedVolatility`
      requests is a curated artifact-valued field — decoration advisory, request closed.

      **Twentieth wave, second slice CLOSED (2026-08-16): the fixed-income next stratum.** The
      curve builders close their options and ladder `referenceDate` (`curves.fromZeroRates` /
      `fromDiscountFactors` accepted a `referencedate` typo silently; a shared-entry closure was
      tried first and RETREATED when the bootstrap heads' wider option shapes broke — per-head
      allowlists are the honest grain here), the bond analytics resolve `priceType` through a
      pre-coalesce enum (null must never silently quote clean), the lattice family ladders
      `stepsPerYear` at its statement positions, and the convertible guards `stepsPerYear` plus
      the survival artifact. Remaining FI residuals are the model methods
      (`G2pp`/`HullWhite#discountBond`), `YieldCurve#addSpread`, the `curveMetrics`/facade
      `.explain` companions, and the swap family's third stratum — the next slice's work list.

      **Twentieth wave, first slice CLOSED (2026-08-16): the backtest front doors.** The
      `SimulatedBroker` constructor — the ONE door `brokers.simulated` also constructs through —
      closes its config and ladders every optional (a `comission` typo left the fee model at
      zero cost; `{ assignment: null }` ran the no-assignment policy silently; the allowlist was
      read from the DECLARED interface after a first guess missed `riskFreeRate` and a test
      caught it). The four options heads (`eventDriven`, `vectorized`, `walkForward`,
      `tearSheet`) run pre-coalesce ladders, and the series predicates (`gtSeries`/`ltSeries`/
      `crossOverSeries`/`crossUnderSeries`) reject a non-finite scalar — every comparison
      against NaN is silently false, which turned a signal series into all-zeros as if the
      strategy simply never fired. The broker method-level residuals (submit/processBar/
      registerOption/settleExpiries and the consumer-model defaults) carry to the next slice.

      **Nineteenth wave CLOSED (2026-08-16): technical-analysis to ONE residual.** The
      price-action heads ladder their optional windows (`strength`/`lookback`/`tolerance`/
      `minSizeFraction`), the microstructure profiles their bins/fractions with `tickSize: null`
      refusing to masquerade as by-count binning, `resample`'s `includePartial` and the
      `weighted`/`signed` flags run boolean ladders, the array-parameter indicators (`kst`,
      `movingAverageRibbon`) reject non-array spellings before `.map` crashes raw,
      `footprintBars`/`mavp`/`searchIndicators` stop coalescing null into enum defaults,
      `barsFromColumns` closes its columns (a `colse` typo silently built bars with no close),
      `tosStdevAll` declares its truthful `period?: number | null` (null = all history IS the
      documented convention), and the order-book consumers are policy `open` (a book carries
      venue decoration). One measurement lesson recorded rather than shipped: blanket-inheriting
      a facade's `open` policy onto its `.explain` twin manufactured 73 false convictions —
      `open` is a promise in BOTH directions, and the twins do not uniformly keep it. The
      inheritance was reverted within one measurement cycle; `microprice.explain` remains the
      one residual carrying that open question.

      **Eighteenth wave CLOSED (2026-08-16): the math package to ZERO.** The trusted-tier
      numerical suite closed with hand ladders (never the generated walker — the solver-wave
      design rule): the optimizer family's shared front door (`goldenSectionMin`/`brentMin`/
      `nelderMead`/`bfgs`/`differentialEvolution` — a missing objective used to crash deep in the
      first evaluation), adaptive Simpson's closed options, the interpolation choke point
      (`validateInterpolationData` carries the axis-option ladders for all three makers;
      `linearInterp` guards its positional lookup point), the linalg heads (`svd`, `jacobiEigen`,
      `pseudoInverse`, `estimateCovariance` with its full method/target/population/market ladder,
      `ledoitWolfShrinkage`), the time-series tests (regression domain `'c' | 'ct'`, finite
      lags), Monte-Carlo (`monteCarlo`'s sampler and closed budget options, `bootstrap`'s
      statistic, `controlVariateEstimate`'s positional control mean — omitted, the
      "variance-reduced" estimate WAS the noise it claimed to remove), and the samplers guard the
      ONE PRNG member they consume while the manifest classifies the generator open (C05: a PRNG
      legitimately carries state decoration; a snapshot arrives from foreign serializers).

      **Seventeenth wave CLOSED (2026-08-16): the strategy leg and options sweep.** The six
      `legs.*` builders close their keys and ladder every field (a `strkie` typo silently built
      an undefined-strike leg; a null expiry coalesced past the spread), the `Position`
      constructor — the ONE entry `strategy`/`strategyOf` and every named builder construct
      through — ladders its config (a null multiplier silently sized at 100, a null market
      priced market-free), `scanStrategies`/`optimizeStrategy` run their option ladders (the
      smile union admits the per-strike FUNCTION form a test taught; `pdfRange` is the declared
      `{ from, to }` object, not the guessed array), the probability heads close their keys, and
      `explainPosition` walks its market override. Strategy 15 → 4 in two passes.

      **Sixteenth wave, second slice CLOSED (2026-08-16): the risk package to ONE residual.**
      Three more strata peeled: `seed` moved to the SHARED entry — a declared option of the
      closed request teaches even when the method never consumes it (the historical path had
      silently accepted a seed the caller thought was set); the constraint objects
      (`transactionCosts`/`turnover`) stopped coalescing null through truthiness; `pca`'s
      matrix-selecting `correlation` flag and `covariance`'s full estimator ladder landed
      (method/target domains, boolean `population`, `market` must be a REAL array — a string
      has `.length` and slipped the ArrayLike test); `deflatedSharpeRatio` stopped crashing raw
      on a null `trialSharpes`; the margin family ladders `multiplier` and pre-coalesces
      `putMarginBasis` into its own enum guard. 49 → 1: the survivor is
      `rawGreeksFromDisplay`'s union-branch omission (a `Greeks | ExtendedGreeks` argument where
      omitting `charm` is legal per the narrower branch), deferred with the measurement
      question it raises.

      **Sixteenth wave, first slice CLOSED (2026-08-16): the risk package sweep.** A package-
      internal when-present toolkit (`options-internal.ts`, absent from every entrypoint) wired
      through 39 ladders in 12 files: the VaR family at its ONE shared entry
      (`valueAtRiskReport` covers `valueAtRisk`/`expectedShortfall` and both explains —
      `{ confidence: null }` used to run at 0.95 and a truthy-string `cornishFisher` silently
      engaged the expansion), `validateConstraints` where null coalesced through TRUTHINESS
      (`{ bounds: null }` optimized unbounded as if unconstrained), the evt/book/book-var/kelly/
      portfolio/attribution/research families (enum domains read from the DECLARED unions after
      two guessed domains broke pinned tests — `bookVaR` includes monteCarlo, `adjustPValues`
      spells benjaminiHochberg), and the stragglers: `explainPnl`'s move members (the attribution
      used to DISCLOSE a zero it never applied), `scenario`/`taylorPnl` positional fronts, and
      `survivorshipWarning` — where `{ includesDelisted: 'no' }` was truthy and silently REMOVED
      the survivorship warning the flag exists to raise.

      **Fifteenth wave CLOSED (2026-08-16): the fixed-income conventions sweep.** One toolkit in
      the package's validate module (`ensureDayCountWhenPresent` with the compiler-checked
      five-member domain, `ensureFrequencyWhenPresent` honouring the named-or-number union,
      boolean and finite when-present) wired through the CDS family (a shared
      `requireCdsConventions` incl. the REQUIRED spread — omitted, it valued the legs as NaN),
      the survival-curve builders, seven swap/rates heads (plus `swapValue`'s required
      `fixedRate`; `forwardSwap` and `swapRate` COMPUTE the par rate, so they must not require
      it — a test caught the over-reach), the four curve-construction funnels
      (interpolation/extrapolation/compounding domains), futures (`notionalCoupon` laddered
      before the coalesce, `refineSwitches` boolean), inflation premiums, the convertible
      (`faceValue`/`recovery`/`settlementDate`/`calls`/`puts`), `cir`'s closed parameters, and
      `adjustDate`'s positional front door (a misspelled convention used to fall through the
      switch and return the date UNADJUSTED as if it had rolled). Measurement side, C05 went one
      level down: `ARTIFACT_VALUED_FIELDS` (contract-policy) routes member mutations under a
      curated artifact-valued REQUEST FIELD (`callableBond`'s bond and curve, the CDS curves, the
      cross-currency legs) to advisory — the request stays closed, the artifact stays open — and
      `adjustDate`'s calendar argument is policy `open` (a built Calendar's members are invoked,
      not validated per-field).

      **Fourteenth wave CLOSED (2026-08-16): the example is the type witness.** The strategy
      builders' 72 residual convictions (optional premiums accepting truthy strings; the covered
      family building NaN positions from an omitted or garbage `stockPrice`) closed at the ONE
      `named()` wrapper: every builder already registers a canonical, buildable example, so the
      wrapper holds each required field to the example's own primitive shape — union-aware,
      because the example shows the bare-strike shorthand while role slots also accept the leg
      object form. Two rulings folded in: a missing slot is convicted only when the builder
      SILENTLY accepts it (curated wrong-shape teaching with received-keys echo wins when the
      builder throws — F15), and optional premium fields share one name-convention ladder in the
      null walk. The chart-types family (39 boundaries) closed the same day at its own choke
      point: `runAggregator` resolves the `flush` flag through the boolean ladder once for all
      ten aggregator heads (`flush: null` used to coalesce into true), and kagi's `percent` flag,
      lineBreak's `lines`, and pointAndFigure's `reversal` stopped coalescing null into their
      defaults.

      **Thirteenth wave CLOSED (2026-08-16): the optional-scalar null-coalescing class.** The
      performance package resolved `periodsPerYear`/`riskFreeRate` at 33 sites through `?? default`
      — `{ periodsPerYear: null }` silently annualized at 252, and a string was DISCLOSED in
      `assumptions` as if it were the applied convention. Two shared resolvers in the conventions
      module now run the optional-scalar ladder (positive-finite for the annualization factor,
      finite for the rate) and every metric resolves through them — BEFORE any degenerate early
      return, because the probes showed an empty series smuggling a null option past validation
      (`informationRatio` returned null instead of teaching; the solver-family law applies to
      metrics too). The same disease in options: eleven boundary validators coalesced
      `dividendYield` before checking it; `blackScholesGreeks`/`blackScholesPriceBounds` had
      missed the 3B.1b-1 kernel front door entirely (a greeks request with a missing leg returned
      a full Greeks object of NaN); the gbm pair split into validated heads plus non-public
      unchecked twins so Monte-Carlo loops stay per-row-validation-free; the batch columns object
      closed over a compiler-checked table (a null `dividendYield` column priced dividend-free);
      and the frozen `market` artifact ladders all six optional numerics plus the dividends array.
      Two measurement rulings: compositional kernels (priceBounds consumed with the IV solver's
      wider input) are policy `open` — key closure would break structural composition and every
      consumed field is required, so a typo surfaces as missing — and `NON_FINITE_IN_DOMAIN`
      curates the boundaries whose declared number accepts NaN BY DESIGN
      (`degenerateAwareDiagnostics` exists to explain a non-finite metric; convicting it for its
      purpose was a false verdict, so the observation lands in advisory).

      **Twelfth wave CLOSED (2026-08-16): declarations tell the runtime's truth — the largest
      single-wave defective drop since the framework choke point (1,139 → 882).** Twenty-five
      indicators declared `period` required while the runtime engaged an industry default (the
      Wilder/DMI family at 14, the Donchian family at 20, the roc family at 10, trix at 30 …);
      convicting the runtime would have broken `dmi(bars)` — the DECLARATION was the lie. Each now
      declares the optional parameter and REGISTERS its default (the `makeIndicator` fourth
      argument), so `.explain()` discloses what engaged; `projected()` grew a defaults passthrough.
      The regeneration order law this wave paid for: `signature:update` FIRST — the contract
      inventory reads `public-signatures.json`, so a declaration-side fix measured without
      regenerating signatures looks like it did nothing. Alongside the declaration class, the real
      guards: `pivots` computed a WRONG pivot from `close: null` (finite ladders on every consumed
      bar field), `divergence`'s swing window was the nested form of the same disease (`?? 5`
      coalesced null, a string swing skipped everything — now typed errors, SwingWindow declares
      its defaults), `register` closes its entry (Law 12), validates `category` against a
      compiler-checked domain table, and ladders the DISCLOSED output metadata (`role`/`unit`/
      `bounds`/`values`, null visualization no longer dies as a raw TypeError), boolean flags
      (`cmo`/`obv` `talib`, `covariance` `sample`, `increasing`/`decreasing` `strict`) stop
      engaging variants on truthy strings via `requireBooleanWhenPresent`, and the bar transforms
      (`bar.*`, `candleColor`, `SqueezeCore#update`) are classified C05 open artifacts — a
      market-data bar legitimately carries decoration; the new `methodInputPolicies` manifest
      field carries class-method policies, since exports-map keys must be live export names.

      **Eleventh wave CLOSED (2026-08-15): the open-artifact analytics and a measurement
      correction the pinned tests taught.** `yieldToCall` and `priceMultiCurve` are the first
      consumers of the OPEN policy end to end: the bond argument's consumed fields run ladders
      while decoration passes; artifact-VALUED fields (`discountCurve`) are curated `unchecked` in
      the spec (`UNCHECKED_ARTIFACT_FIELDS`) because the curated instance guard — "expected a
      curve built by curves.fromZeroRates(...)" — teaches better than a projected member walk.
      And the measurement learned C05's other half: MEMBER mutations on an OPEN-policy argument
      are ADVISORY, not authoritative — the harness had convicted `priceMultiCurve` for accepting
      a curve without `addSpread`, a method it never consumes; which members a boundary consumes
      is not statically knowable, so those observations force `partial` for per-boundary
      adjudication, the same doctrine that keeps container mutations advisory. 21 boundaries moved
      defective → partial under the corrected rule. The four facade-wrapped analytics
      (`yieldToMaturity`, `priceFromYield`, `curveMetrics`, `yieldMetrics`) and every `.explain`
      companion remain the facade-template item.

      **Tenth wave CLOSED (2026-08-15): the volatility package sweep, 50 → 5.** Forty-five
      boundaries across eighteen files through the generated specs; the five residuals are the
      positional-scalar formulas pruned from the roster by design (`calendarSkew`,
      `forwardVolatility` — H21/H22's ratified plain scalars take hand guards, the solver
      precedent). Earned along the way: ROOT-UNION support — a union PARAMETER carries its arms at
      the parameter level with `fieldTree` holding only the common members, and the first emission
      silently over-closed `phiValue` to its discriminant, rejecting every declared-legal call;
      the generator now projects root branches (and throws on an unprojectable all-primitive
      union), the validator resolves them discriminant-first, and a PURE discriminated union
      refuses a MISSING discriminant on the discriminant itself with the whole domain (the
      standing `ensureEnum` convention; unions with structural arms keep the every-alternative
      teaching). Adjudicated: `SwaptionCube.shift` was declared required while evaluation
      documents the legacy default of 0 — the declaration lied and is now optional; five tests
      pinning the old taxonomy (null-as-omission on `sabrBartlettGreeks`, wrong-type-for-absence
      on quotes/windows/strikes, `negative_spot` for Infinity) were corrected with the ruling
      cited; `garchForecast`'s domain probe now poisons a REAL fit so the domain check is the
      thing tested.

      **Ninth wave CLOSED (2026-08-15): the options trio — `sabr`, `engines`,
      `local-volatility`, 25 paths → 0.** Eighteen implementation heads through the generated
      specs (namespace + flat spellings share one head, the heston pattern). Two finds worth
      keeping: `engines.localVolatility` validated its options and still ACCEPTED an omitted
      surface callback — the factory returned a complete-looking engine that only failed lazily
      at price time, so the callback takes the solver-family typeof check (a callback has no
      generated key; its guard is always hand code). And `calibrateSabrSmile` remains defective
      by design of this wave's scope: it is the VOLATILITY package's calibrator measured through
      the sabr declaration file — it belongs to the ssvi/volatility cluster next in the queue.

      **Eighth wave CLOSED (2026-08-15): the root-finder family, 30 paths → 0.** The solvers
      honored design law #4 for VALID problems (`converged: false`, never a fake success) while
      RETURNING on malformed ones: `brent(f, 1, undefined)` reported
      `converged: false, reason: 'no_sign_change'` — a plausible wrong answer that reads as "no
      root in the bracket". One shared `requireSolverInputs` head now runs the four-code matrix
      positionally (omitted coordinate → `missing_field` with the worked example; a string is
      `wrong_type`, not a "non-finite number" — bare `ensureFinite` taught the useless code here
      once before) and validates the options object against its generated spec. The module was
      import-free by style; Law 15 is explicit that malformed options and callbacks do not
      inherit the kernel's IEEE exception.

      **Seventh wave CLOSED (2026-08-15): `options/heston`, 11 → 0.** Six implementations serve
      the eleven paths (the `heston.*` namespace aliases the flat kernels), so six
      `validateClosedRequest` heads cover both spellings; the nested `HestonPriceRequest`
      (`type`/`input`/`parameters`/`options`) validates recursively from one generated spec —
      `parameters.kappa: null` teaches at its dotted path. Domain checks (positivity, the
      Feller-condition warnings in `validateParams`) stay behind the shape gate untouched.

      **Sixth wave CLOSED (2026-08-15): the strategy-builder choke point.** Every generated builder
      (`bullCallSpread`, `ironCondor`, …) crosses ONE `named()` wrapper, which already carried
      Law 12 for unknown keys — and treated null fields as absent: `{ expiry: null }` fell through
      each builder's `?? default` and silently built an expiry-less position (`expiry` alone
      convicted 333 times; 177 boundaries carried null failures, 105 on nothing else). The wrapper
      now walks the input and config trees — nested objects and leg arrays included, since
      `market.dividendYield: null` defaults as silently as a top-level null — and teaches
      `input.wrong_type` with the omit-instead correction. No builder input declares `| null`
      (the nullable declarations live in chain-row inputs, a different surface), so the walk is
      unconditional. defective 1,490 → 1,385; the null population 437 → 378.

      **Fifth wave CLOSED (2026-08-15): the 68 TA Stream-constructor back doors — zero remain
      defective.** The facades validate through `makeIndicator`'s resolve, but the exported Stream
      classes construct directly: `new AlmaStream({ period: null })` built `weights: [null],
      denom: 0` with no error, and the 68 constructors were convicted on every mutation class.
      Each now runs `requireStreamParameters` (package-internal, `stream-validation.ts`) as its
      first statement, validating against the SAME checker-generated spec as every other boundary;
      the teaching names the resolved-parameter key skeleton and points to the `.stream(…)`
      factory as the front door that applies declared defaults. One nuance preserved verbatim:
      `StochasticStream`'s destructuring default (`smoothK = 1`) moved with the destructure.

      **Fourth wave CLOSED (2026-08-15): the TA framework choke point — one gate, 981 defective
      records cleared, the largest single movement of the phase.** 349 of TA's 648 defective
      boundaries were the framework-generated `.explain`/`.stream` companions, 279 of them
      convicted ONLY by `null-when-nonnullable`: `makeIndicator`'s shared `resolve` step treated a
      null parameters argument as omission (`parameters ?? {}`) and let `{ period: null }` fall
      through each indicator's `p.period ?? default` — the silent-default class, at the single
      point all ~335 indicators share. The gate now rejects both (`input.wrong_type`, teaching
      "omit the field to use the declared default") — with the exemption the ruling itself
      requires: a parameter whose DECLARED DEFAULT is null is definitionally nullable
      (`tosStdevAll.period: null` means "all bars"; the disclosure-law suite caught the blanket
      version in one round, and the exemption reads `meta.defaults` rather than a hand list).
      defective 2,553 → 1,572, enforced 799 → 1,086, the null population 1,033 → 505, TA defective
      648 → 224. The remaining TA defectives are the per-file indicator functions' own boundaries
      and the Stream-class constructors — per-cluster work, not another choke point.

      **Third cluster CLOSED (2026-08-15): `fixed-income/bonds`, the spec-projectable 8 of its 12 —
      all `enforced`, and two machinery capabilities earned their live proof.** The `Amortization`
      union resolves discriminant-first in production (`{ type: 'bullet' }` teaches the whole
      domain; `{ principalByPeriod }` selects structurally; a chosen arm is closed against the
      other arms' keys), and MIXED primitive unions project honestly: `Frequency = 'annual' | … |
      number` collapsed to `numeric` in the outer kind and the first emission rejected
      `'semiannual'` — 17 tests caught it — so the generator now pools field-less literal arms into
      `literals` with `openKinds` for the open primitive beside them, and a numeric spelling still
      runs the finite ladder. The builders retired `requireSpecification` (another old-taxonomy
      null-as-missing site) while keeping its bespoke teaching verbatim (`specificationExampleCall`
      + `FIELD_HINTS` feed the shared validator's `teaching`), and the `Bond` artifact's
      `cashflows`/`futureCashflows`/`accrued` now validate their projection context — the
      rich-methods-outside-facade-guards class, closed for this artifact. The four `.explain`
      companions and the analytics family (`yieldToMaturity`, `priceFromYield`, `curveMetrics`, …)
      remain: they take the facade-template path and the OPEN-artifact consumed-fields treatment
      respectively, each a distinct follow-up. Evidence:
      `packages/fixed-income/test/bonds-contract.test.ts`. (The 2026-08-10
      sizing — 611 / 313 / 298 across 66 files — had already drifted to 626 / 331 / 295 / 66 by the
      RV31 artifact before any fix landed; the same ungated-prose lesson as the paragraph below.)

      **Second cluster CLOSED (2026-08-15): `options/exotics`, 41 → 0 — every boundary reads
      `enforced`, and the migration is the reusable validator's first consumer.** 57 generated spec
      keys, 57 consumed call sites, audited exact. The redundant hand heads
      (`requireArgumentObject` + per-field `ensureEnum` + hand enum consts) are deleted — the
      declaration is the single runtime source — while every domain check (positivity, corridor
      and correlation relationships) stays. Two findings the migration surfaced, both settled:
      absent required ARRAYS (`weights`, `observationTimes`) had taught `wrong_type` and two
      deep-sweep tests pinned it (the taxonomy says omitted → `missing_field`; tests corrected),
      and the cliquet/napoleon ±Infinity bounds became the curated-bounds mechanism above.
      Family-sweep regression evidence: `packages/options/test/exotics-contract.test.ts`; scalar
      cost evidence: `packages/options/bench/exotics.bench.ts` (barrier.price ≈ 530 ns/call
      absolute, validation and Reiner–Rubinstein together — C14 reports the absolute number).

      **First cluster CLOSED (2026-08-14): `math/statistics`, 19 → 0 — corrected the same day after
      an independent review of the pilot commit (`52f4e422e`) found the fix had reproduced two of
      the library's own defect classes.** What stands now, with the review's corrections:

      - The 18 series reductions validate their options as closed requests — unknown keys teach
        with a did-you-mean, `nanPolicy` runs the enum ladder (a wrong-typed policy used to fall
        through `prepare`'s branch chain into `throw` semantics, a silent behavioural change),
        booleans and fractions run the wrong-type/finite ladder.
      - **The rolling family had been given an option it explicitly does not support.** The pilot
        typed `rollingStandardDeviation`/`rollingCovariance` with `VarianceOptions`, so a
        `nanPolicy` was validated and then IGNORED — `{ nanPolicy: 'throw' }` did not throw on NaN.
        Accepted-but-ignored is the H03 class. `PopulationOptions { population }` is now split out;
        the rolling functions and `covarianceMatrix` take it, and a `nanPolicy` there is an unknown
        key that teaches.
      - **`null` is not omission.** The pilot skipped `null` fields as absent, and the generated
        contract says every one of these fields is `nullable: false`. The ruling from C06: optional
        `undefined` omits; non-nullable `null` rejects (`input.invalid_enum` for the enum,
        `input.wrong_type` for booleans/numerics); `null` is accepted only where a declaration
        spells it. `ensureFiniteWhenPresent` in `core` carried the same early-return-on-null and is
        corrected — its taxonomy test had pinned the defect in place as expected behaviour. The
        class is now MEASURED: the `null-when-nonnullable` mutation (proven by plants in
        `contract-probe.test.ts`, authoritative only against a declared non-nullable field) runs
        9,205 probes and convicts 1,081 non-umbrella boundaries across 145 files — the reason
        `defective` doubled in the header, and the next large burn-down population.
      - **Validation runs once per external call, not once per internal stack frame.** The pilot
        re-validated through `standardDeviation → variance → mean → sum` and per matrix pair, and
        defaulted `options = {}` so the `undefined` fast path never ran — measured at 3.6x on
        500k eight-value `standardDeviation` calls. Public boundaries now validate once and
        delegate to package-internal helpers (`statistics-internal.ts`, absent from the exports
        map); allowed-key lists and field paths are precomputed at module load. Re-measured after
        the restructure: 500k eight-value calls 13.7 ms vs the parent's 13.1 ms, and 5k 12×24
        `covarianceMatrix` calls 42% FASTER than the parent, because the pairwise loop now takes
        the internal path. Committed evidence: `packages/math/bench/statistics.bench.ts` — quote
        the bench output, and read the rme before quoting anything.
      - The allowlists are COMPILER-CHECKED against the declared interfaces
        (`Record<keyof T, kind>` + `satisfies`, one shared spec including `covarianceMatrix`): an
        interface field the validator does not know fails the build, and a listed key the interface
        lacks fails the same way. Call this compiler-checked, not generated — it is sufficient for
        single-shape contracts; union-shaped clusters (`exotics`) take checker-derived per-branch
        lists and the reusable shared validator contract BEFORE that cluster is attempted.

      Exact-code regression fixtures: `packages/math/test/statistics-options-contract.test.ts`.
      `unmeasured` did not move (163, `baseline-rejected` 88): no over-closure. Cost recorded in
      the bundle budgets: the statistics module carries the guard once (+1.2 KB gzip on
      `@totalfinance/math`), and five budgets re-seat on the measured values.

      The original figures (543 / 276 / 267 across 65 files, `exotics` 21) were correct when written
      and drifted the same day: 4e3bea33 ("an intersection is an object") and 7ec0a4eb (intersection
      field trees) widened the measured population, and the gated header in this file CREDITS that
      expansion for unblocking this very item while the item's own sizing was left behind. `exotics`
      is twice the stated size. Ungated prose rots even when the commit that rots it is refreshing
      the gated numbers three paragraphs above.

      **UNBLOCKED (RV15/RV16). This paragraph said the opposite for two rounds after it stopped being
      true.** It read "only one branch of each union is exercised, and the branch selected can be the
      wrong one" — which was correct when written and became a contradiction of the header the moment
      per-variant measurement landed. Every declared alternative is now enumerated as a discriminator
      variant, measured on its own, and aggregated pessimistically; branch SELECTION is
      discriminator-first rather than key-set matching. A stale sentence in a tracker is not a
      cosmetic defect: this one told a reader to discount evidence the artifact had already produced.
      Every intersection parameter records a full
      field tree, built from the parameter's own checker type rather than looked up by declaration
      identity, and `barrier.monteCarloPrice` records all nine of its keys. A generator-level gate
      re-resolves every public compound parameter through the checker and fails on a mismatch, so a
      bad regeneration cannot quietly become the new baseline.

      **Corrected, 2026-08-09 (RV12-4).** The previous wording said "all 133 intersection parameters"
      and described a gate that compared, in both directions, a set of labels shaped
      `<owner>#<parameterName>`. Three things were wrong with that claim, and they are worth keeping:

      - **The population was selected textually.** A parameter entered the comparison only if its
        rendered type contained `&`, so a compound contract behind an alias — `FromChainOptions` —
        was skipped, and nothing distinguished "skipped" from "agreed."
      - **A name is not an identity.** Keyed by parameter name, the gate compared slots that were not
        the same slot. Identity is positional now (`|sig<N>|arg<M>`), in the three senses RV12
        separated: public occurrence, implementation occurrence, declared contract.
      - **The residual was not a generator gap.** Asked by contract rather than by path spelling, all
        thirteen entries dissolve: three were the `&` selector, and ten were one declaration reachable
        under two public spellings (`@totalfinance/strategy:strategy.coveredCall` and
        `@totalfinance/strategy:coveredCall` are the same contract, recorded the whole time).
        `CHECKER_ONLY_KNOWN` is now empty, and stays as the thing that fails if a real gap appears.

      Measured at this commit: **156 public compound parameter occurrences** re-resolved through the
      checker, **0 unrecorded**, 10 reached under a second spelling, 2,884 implementation occurrences
      with **0 unresolved**. Two consistency invariants hold with no allowlist — one declared contract
      records one shape across 450 shared groups, and one implementation slot at one instantiation
      records one shape across 2,120. Grouping by implementation *alone* is false and measurably so:
      `Facade.explain`, `Indicator.explain` and `Indicator.stream` are generic, so one slot carries a
      different contract per instantiation, which is why the instantiation joins the key.

      **Widening the population to unions found two live defects**, both fixed here and both
      invisible to the old gate, which admitted only intersections:

      - `deflatedSharpeRatio(statistics, trials)` declares `trials` as a two-branch union of objects.
        `isSeries` tested the rendered type by SUBSTRING, the text mentions `ArrayLike<` inside one
        branch, and the parameter was filed `series` — a kind that carries no field tree. Both
        branches of a public contract went unrecorded. The textual test is anchored per branch now; it
        cannot simply be deleted, because `checker.isArrayLikeType` is false for the `ArrayLike<T>`
        interface and so the text carries real load.
      - `branchFields` was emitted only when `kind === 'object'`, so
        `classifyStrategy(Position | ReadonlyArray<LegInput> | ReadonlyArray<ClassifiableLeg>)` — which
        reads as a series, correctly — described its `Position` branch nowhere. `kind` answers what a
        caller passes and what synthesis can build; `branchFields` answers what each alternative
        requires. Tying the second to the first lost the first question's losers.

      The gate is proven by planting the seven defects it exists to catch — a dropped field, a deleted
      contract, two paths of one contract disagreeing, an emptied branch, a dropped branch, a renamed
      branch field, and an unresolvable implementation. All seven fail it. The emptied-branch probe
      passed at first: a fallback that looked a contract up by implementation whenever the direct
      entry was empty answered with an intact sibling path. An empty record and an absent record are
      different facts, and only the second may fall back.

      The blocking condition, kept because it is the reason the gate exists: the record used to omit
      every member declared inline, so a key list closed on it would have rejected `type` and
      `barrierType` — refusing valid calls in the name of fixing permissiveness, the worse defect of
      the two.

      Two derivations were tried and both are wrong, recorded so they are not tried again. Reading the
      `fieldTree` alone drops the inline members. Recovering the missing discriminants by regex over
      the source mis-derived 3 of the 21 `exotics` boundaries then measured (41 now) — `basket` and `spread` lost `type`,
      `rainbow` lost `type` and `kind` — because those write `ensureEnum(x, ['call','put'] as const,
      …)` rather than naming an enum constant. A 14% silent error rate on a "mechanical" method.

      The fix shares `walkField(checker, name, type, …)` rather than adding a second walker: two
      implementations of "what fields does this type have" is how one declaration gets two answers.

      When it does run: watch `unmeasured` alongside the verdict counts, because over-closure surfaces
      as `baseline-rejected` — a measurement lost rather than a test failure.

- [ ] Generate negative-fixture mutations where structurally possible: omit each required field, add
      a near-miss key, pass `undefined`, pass the wrong primitive/container, and inject `NaN`/±Infinity
      into finite numeric fields.
- [ ] Assert exact `QuantError` code, field path, and useful correction—not merely “some exception.”
- [ ] Add representative nested-object, array-element, returned-artifact method, JavaScript, and
      `any` escape-path fixtures.
- [ ] Remove package-wide and `tier !== 'facade'` exclusions from object-contract mutation
      coverage. Probe `core` and `math` request/options/configuration objects under the same
      identity-based policy as every other package.
- [x] Fix the Black-Scholes and Black-76 seed defects through the shared enforcement path. **DONE
      (3B.1b-1).** Both read `enforced` in `public-enforcement.json`, and their fixtures carry
      `closedIn: '3B.1b-1'` — a marker the conformance gate reads in BOTH directions, so a row cannot
      claim closure the measured record does not support.
- [x] Keep unchecked financial/object-backed numeric routines file-private and reachable only after
      validation. **DONE (RV1, corrected in RV5).** Every solver objective, facade, calibration
      objective and finite-difference bump routes to an unchecked kernel behind a boundary that
      validates once. The kernels stay off the public surface — file-private where the caller shares
      the module, and in a module absent from the `exports` map where two public subpaths need to
      share one. Conventional public positional scalar math primitives retain their explicit
      mathematical/IEEE contracts without universal parser wrappers. Batch and `*Into` paths remain
      the throughput architecture.

      RV1 first claimed this line complete while three paths still ran guarded calls and the
      benchmarks did not cover the ones it named. What the claim now rests on, path by path:

      | Path | Routing | Evidence |
      | --- | --- | --- |
      | BSM / Black-76 / Bachelier IV solvers | objective unchecked, boundary validates once | `bsm-batch.bench.ts` (kernel A/B + 20k-solve suite); `solver-boundary-validation.test.ts` |
      | `calibrateSsvi`, `calibrateEssvi` objectives | `phiValueUnchecked`, `ssviSliceWUnchecked` | four calibration benches in `surface.bench.ts` |
      | `ssviArbitrageFree`, `essviArbitrageFree` | one grid sweep per maturity, terms hoisted out of the crossed loop | 359 volatility tests unchanged |
      | Heston `cosGreeks` FD bumps | `cosineExpansionPriceUnchecked` | `heston.bench.ts` |
      | `impliedVolatility` method suite (Newton/Halley/Householder + acceptance) | `blackScholesPriceUnchecked` | four method benches in `bsm-batch.bench.ts` |

      Two corrections behind that table. Black-76 and Bachelier had received the unchecked objective
      WITHOUT the boundary check — a string `forward` returned `converged: true` — which is why the
      solver suite now asserts that no solver may RETURN on malformed input. And the calibration and
      arbitrage scans were never on a benchmark, so the optimizer objective, the one path the whole
      argument is about, was the single path nobody measured. Verdicts are unchanged across all 4,350
      records.

      A third correction, on the word "every". RV5 wrote that every solver objective was routed while
      `iv.ts` — the robust public method suite — still called the guarded facade once per Newton /
      Halley / Householder iteration AND again per candidate root during acceptance. That is the
      solver family with the highest kernel-calls-per-solve ratio in the library, so the one path
      where the routing mattered most was the one the sentence was wrong about. It is routed now and
      benchmarked; the table above is the scope of the claim, and "every" means the rows in it.

      A fourth correction, on the evidence rather than the code. RV1 quoted "2.34x on the solver" and
      "3.98x on the kernel" from one-off scripts that were never committed, so neither number could be
      re-run — a performance claim whose evidence has no home is the same shape of defect as a gate
      that no longer gates. Both measurements now live in `packages/options/bench/bsm-batch.bench.ts`:
      a guarded-vs-unchecked A/B on identical arithmetic at 200,000 calls, and the shipped scalar
      solver at 20,000 solves, so the kernel-level and solver-level figures come from one run instead
      of being stitched across machines. Quote the benchmark output, not this paragraph — and read the
      rme before quoting anything, since a figure taken under load has been wrong here before.

- [ ] Benchmark representative scalar and 100,000-row batch paths. Runtime safety may have a measured
      scalar cost; it may not add per-row object validation/allocation inside already validated
      columnar loops or silently select an unsafe public overload.

**Commit boundary:** validation primitives, generated mutation harness, seed fixes, parity, and
performance evidence.

### 3B.2 — Dependency-ordered package migration

Migrate by a generated topological package order, foundations before consumers. Commit one package or
one tightly coupled contract family at a time; every commit must leave the repository green.

For each package slice:

- [ ] bind every object input to a runtime validator/enforcement owner;
- [ ] review every recursive consumed field against the semantic policy;
- [ ] make meaning-changing defaults explicit and echo engaged defaults in assumptions;
- [ ] for facade/analysis/artifact results, replace undefined successful quantities with
      `null`/omission plus a field-specific reason while preserving documented expert-kernel IEEE
      behavior;
- [ ] verify facade/raw/professional/batch/artifact parity where multiple layers answer the same
      question;
- [ ] update API reports, manifests, first-touch fixtures, generated READMEs/LLM docs, MCP linkage,
      and packed consumers in the same commit;
- [ ] pack and install the actual affected tarball in a clean smoke consumer in the same commit:
      prove changed root/deep imports, one JavaScript runtime call, one strict TypeScript call,
      removed/malformed forms where relevant, and at least one affected downstream tarball when a
      shared upstream contract changes; then
- [ ] burn each package's unresolved contract count to zero before advancing to its dependents.

Do not use package order as a reason to duplicate validators. A lower shared contract is fixed once;
consumer packages prove they delegate to it.

### 3B.3 — Quant-answer result decisions

Regenerate `HELPER_QUANT_ANSWER_BACKLOG` after the package sweep, then implement every H-series
decision in the
[`Phase 3B decision ledger`](./phase-3b-decision-ledger.md#helper-quant-answer-decisions). Add and
decide any genuinely new generated identity before migrating it.

For each answer, record:

- the question the caller is asking;
- its manifest role and current result;
- its source-controlled impact labels from the decision ledger;
- whether assumptions/diagnostics are necessary to use the number responsibly;
- the chosen plain/facade/analysis/artifact grammar; and
- either the migration or the source-controlled reason the plain result is complete and
  unsurprising.

“Existing behavior,” brevity alone, or fear of pre-1.0 breakage is not a rationale. Do not envelope
ordinary formulas merely to make the ledger empty.

Every entry beyond `ratification-only` lands an exact before/after regression, executed packed
consumer, generated contract/doc updates, changeset or release note, and migration guidance for
accepted-input or successful-result-shape changes.

**Commit boundary:** small domain-coherent and impact-coherent groups. Each commit removes its
resolved entries and their stale “pending” notes.

### 3B.4 — High-level positional-pair decisions

Regenerate the high-level `natural-positional` pair set, deduplicated by implementation identity,
then bind and prove every P-series decision in the
[`Phase 3B decision ledger`](./phase-3b-decision-ledger.md#high-level-positional-pair-decisions).

Retain a pair when:

- the concepts are role-distinct or conventionally ordered;
- realistic transposition is implausible or fails structurally;
- an object would add ceremony without making future growth safer; and
- the source-controlled rationale names that reasoning.

Migrate a pair when both values are financially confusable, the operation is already conceptually one
request, or likely evolution would create an optional-argument hole. Removed pre-1.0 forms receive
compile-fail evidence, not compatibility overloads.

**Commit boundary:** policy and compile/runtime evidence for one coherent domain at a time.

### 3B.5 — Cold packed-package journeys

This is the cumulative exhaustive matrix, not the first time a migrated package is packed. The
minimal per-slice tarball smoke in 3B.2 prevents export-map and packaging defects from surviving
until closeout.

- [x] Pack and install the actual package tarballs in clean JavaScript ESM, `require(ESM)`, esbuild,
      TypeScript `NodeNext`, and TypeScript `Bundler` consumers. CLOSED 2026-08-19: all five
      consumers run in `tools/packed-consumer.test.ts` against freshly packed tarballs in a
      temporary out-of-tree project.
- [x] Exercise flagship, raw kernel, professional contract/market, batch, and returned-artifact
      journeys. CLOSED 2026-08-19: the ESM/TypeScript consumers price through the flagship facade,
      the named raw kernel, the professional contract/market path, the columnar batch, and read a
      covariance artifact's members — each asserted against the same reference value.
- [x] Include omissions, common misspellings, extra keys, explicit `undefined`, wrong primitive and
      container types, non-finite values, degenerate-valid inputs, and plausible transpositions.
      CLOSED 2026-08-19: the 3B.5 misuse matrix in `tools/packed-consumer.test.ts` probes every
      class from the packed install — each asserts the exact teaching code, the misspelling probe
      asserts the did-you-mean names the real field, the degenerate-valid probe asserts the
      documented warm-up convention answers rather than throws, and the batch probe asserts the
      failing row's INDEX survives packing.
- [x] Assert successful correction in one round trip for teaching errors. CLOSED 2026-08-19: the
      omission probe evaluates the caught error's own `e.g.` example VERBATIM and asserts it
      computes — the taught fix is executable, not prose.
- [x] Verify source maps, generated API examples, MCP schemas, and direct SDK calls agree on names,
      units, defaults, nulls, and errors. CLOSED 2026-08-19: the generated README examples
      typecheck AND run against the packed install (names/units/defaults proven executable); the
      MCP server constructs from the packed tarball, and its schema/SDK field agreement is pinned
      by the MCP package's own schema conformance suite; `jsonSafe` pins the null encoding.

Workspace imports do not count as packed-consumer evidence.

### 3B.6 — Closeout and permanent ratchets

- [x] Zero unowned public object contracts. CLOSED 2026-08-19 by reconciliation: the 3B.6 ownership gate proves every statically-unattributed contract behaviorally owned, honestly unmeasured, or a member of three named machinery classes — remainder exactly [].
- [x] Zero unresolved semantic fields. CLOSED 2026-08-19: naming unresolved = 0 (gated); every declared-vs-runtime semantic divergence found by the campaign was fixed declaration-side or runtime-side, never tolerated.
- [x] Zero missing validator identities for closed inputs or consumed open fields. CLOSED 2026-08-19 and refreshed 2026-08-27: 202 validator identities, checklist-bound; defective 0 with every closed request and consumed open field behind a measured guard.
- [x] Zero package-wide or manifest-tier validation exemptions; every retained exception is bound
      to a stable contract identity and rationale. CLOSED 2026-08-19: the C20 gate derives boundary
      kinds exhaustively with no package/tier exclusion, and every curated exception names its
      enforcing boundary (the ≥30-character rationale gate).
- [x] Zero helper-answer entries lacking an implemented decision. CLOSED 2026-08-19: H-ledger 0 of 36, gate bound at zero — a new plain-value answer must be decided, not accumulated.
- [x] Zero high-level positional pairs lacking an exact-live rationale or migration. CLOSED 2026-08-19: 34 retained with per-entry rationale (P01–P30 + the dated re-entries), 0 migrated, drift-evidenced by the exact-count pair gate.
- [x] Zero stale TODO/backlog/completion claims across active trackers. CLOSED 2026-08-19: every backlog note in the hand manifests now records its decision; the gated prose quotes the artifacts; closed tracker rows stay dated per the standing convention.
- [x] Full format, lint, typecheck, build, coverage, API-report, runtime-manifest,
      signature/contract-manifest, generated-doc, benchmark, and installed-tarball gates pass.
      CLOSED 2026-08-19: `pnpm run ci` green by exit value (377 files / 8,023 tests incl. the
      packed-tarball matrix); the committed benches execute green (numbers quoted only from idle
      machines per the standing rule).
- [x] Publish the final path/implementation/contract counts and package-by-package evidence in the
      alignment closeout. CLOSED 2026-08-19: `library-alignment-spec.md` §"Phase 3B closeout" quotes
      every count from the committed artifacts, all gate-bound.

Phase 3B closes only when the generated live surface agrees with the committed evidence. A manual
checkbox cannot waive drift.

## Commit sequence

1. `phase3b: generate public contract inventory`
2. `phase3b: enforce runtime object contracts` (foundation plus BSM/Black-76 seeds)
3. `phase3b(<package>): close runtime and field contracts` (repeat in topological order)
4. `phase3b(<domain>): implement settled helper answer grammar` (repeat by coherent domain)
5. `phase3b(<domain>): bind and prove retained positional pairs` (repeat by coherent domain)
6. `phase3b: prove packed misuse journeys`
7. `phase3b: close runtime semantic surface`

The exact commit messages may vary; mixing all package migrations into one unreviewable commit may
not.

## Parallelization rules

After Phase 3B.N, 3B.0, and 3B.1 freeze the vocabulary, inventory schema, and enforcement utilities,
independent package slices
may proceed in parallel only when they do not edit the same shared contract or semantic vocabulary.
One owner integrates generator/policy changes. Alias paths never become separate migration streams.

## Non-goals

- another blanket object-versus-positional migration;
- public positional/object compatibility overloads;
- one heavyweight schema parser inside scalar hot loops;
- provider, network, credential, database, MCP-hosting, UI, or WASM work;
- changing quantitative models merely because their boundary is being validated; or
- declaring every helper an analysis report.

## Exit statement

After this phase, TypeScript helps before execution and the JavaScript runtime teaches the same
contract during execution. Every new platform-core API must satisfy these ratchets in its first
commit, and the complete gate reruns against the final platform surface before core freeze.

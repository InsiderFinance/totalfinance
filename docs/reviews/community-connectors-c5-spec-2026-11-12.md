# C5 specification evidence and checkpoint

Request f417317e-89d8-8c08-8867-defc21e5f479; feature01a19da0-2a6f-7450-89a4-2e51047b05b5,
existing execution01a19da1-1351-7b84-b67f-58bc81698fb5. Ri task body revision43 read, including
maintainer authorization and unchanged live/release/account restrictions. No feature completion.

New worktree /Users/agent/ri/.work/worktrees/totalfinance/totalfinance-c5-author-contract,
branch totalfinance/community-connector-c5-author-contract, based exactly reviewed3bc356ffc2ac4d0cc8e1c3f5214e56d851c282b2.
Fetched origin/mainca122ab3115ea08cc8789fd7d1be8380382fdc6c is already an ancestor, so no additional
integration required at this checkpoint. Recheck at implementation/PR preparation. No reviewed tree
or provider checkout edited, no remote push or PR change in C5.

Read AGENTS/CONTRIBUTING/queue and full C0/C2/C3/C4 contracts, complete attachment
/Users/agent/ri/attachments/01a1d06f-52c9-7176-be78-eab41df0f26e.md, independent source
/tmp/tf-pr26-review-61e10f/author/src/{index,vendor}.ts and coordinator
/tmp/tf-c5-review-observations.json. Originals unchanged. Review's page50000 claim is qualified:
Polygon's own client describes base aggregates; Alpaca official stock-bars reference supports10000
and broader timeframes. Only public documentation browsed, no market-data API call.

Source evidence driving proposals:

- data-types.ts: separate source/consumer protocols, cursor-only continuation, literal1d/1m,
  duplicated normalized envelope, native close/OHLCV selection, v1 window shape.
- data-validation.ts requestData/capabilityData: universal2000 and31-day bounds; daily midnight
  timestamp and strict OHLC inequalities. Existing window ALSO checks original query bounds;
  C5 does not claim this was missing.
- data-call.ts: instanceof QuantError/InputError and generic invalidResponse for unknown provider
  throws; C4 known schema diagnostics deliberately use a trusted internal mark. Preserve that mark.
- data-connection.ts: defaults1000/20/20000, hard2000/100/100000, strict terminal walk,
  retained pages within walk but no public checkpoint on failure, nonenumerable lazy selections.
- core market-data.ts Bar retains timestampMs already; resample.ts TimeBar volume optional and
  current resample defaults missing volume to zero. New convenient bars must REQUIRE actual
  volume to avoid accidentally invoking that behavior. No compute change.
- backtest vectorized.ts accepts timestamped bars; new structural projection adds no pricing engine.

C5 proposes source-only connect binding/protocol2, single financial query on every page,
SDK envelope stamping from page-specific explicit facts, finite understood intervals and separate
host/read/record/work/memory bounds, code/descriptor-based safe cross-copy errors and controlled
teaching, actual04Z/session-start and strict timestamped bars. One explicit checkpoint accessor
preserves existing error classes; resume validates/carries consumed work. Acquisition retains suspect
finite OHLC with issues; default affected selectors stop, resolve explicitly excludes/uses/corrects
with immutable decision ledger and unchanged originals. No extra clean-example policy ceremony.

This is a decision-complete PROPOSAL; protocol2, new workflow/quality choices and exact bounds have
not been approved by maintainer's acceptance of an unseen design. Coordinator review is next.
No runtime/signature edits, budget changes, package version, provider worktree, live action or
new provider claims. C4 green fast43118076015/full43118075974 remains historical only. Documentation
verification will record actual commands/results below; no implementation tests claimed.

Documentation-only verification (Node22.23.2/pnpm10.32.0): frozen install/build passed; scoped
Prettier and git diff checks pass. Existing documentation conformance25/25 passes. Only affected
documentation inventory generator ran:263 surfaces,4673 executable fences,0 findings. The initial
six vocabulary findings concerned compact synthetic vendor fields; illustrative vendor fields were
made descriptive, with no policy/gate exception. No C5 runtime/consumer/provider compatibility
or hosted acceptance claimed. The independent exp1–exp5 probes were read, not executed/modified.

Original SHA256 controls:
attachment2a61eb96f214cb35b661703f6c4bdf058143f7a62cc9fac3d116bddd592f2ae1;
author/src/index.ts2a56b4169127b68e0ea4861b39e469c19cf5ab0b1f426b482df822f6b8c439ca;
author/src/vendor.ts54553b110f050787ac0f4c99ad25e154d44885b62055eb3bfefb1373bb27df4e.
The source-only proposal deliberately chooses one raw-source binding, protocol2 and windowv2,
finite interval set, explicit consumed-work resume and resolve choices; these are coordinator
review decisions, no hidden unresolved product question or new generic maintainer approval loop.

## Changes-requested disposition and revised contract (2026-11-12)

Coordinator request101c2e57 reviewed6f3fdd6/all481 lines; exact-output changes_requested
review01a1d099-f101-7b77-b52e-a22eb31b5d6f/output01a1d094-18fa-76b1-b717-14a4d08946a5 is
preserved in Ri task revision45. No C5 runtime approval. Earlier “decision-complete” proposal
claim is superseded by this concrete correction/re-review; maintainer implementation authorization
remains, with no generic permission question.

1. v2 canonical page has one SDK-stamped binding holding original DataQuery and provider id/version,
   no redundant page interval. Both bars/filtered chains restore exact continuation with zero
   discovery; mismatched external query/binding refuses before I/O. Legacy v1 cannot synthesize
   missing query/version; reports unavailable-legacy-context and retains strict old restore laws.
2. Checkpoint paging keeps requested automatic/explicit and unresolved/resolved effective size,
   separate from accepted-page/record/read budgets. Failed initial discovery remains unresolved;
   automatic1000 may negotiate50 later, explicit1000 refuses. Zero accepted pages alone means first
   request; an accepted empty nonterminal page retains cursor/pins/counts. Saved budgets stay saved
   on a larger default connection; explicit resume option, else explicit constructor option, else
   saved limit determines each budget, always <=connection/hard ceilings and >=consumed work.
   All valid-checkpoint pre-I/O refusals retain it; fresh discovery/query accounting is explicit.
3. bars is readonly Readonly<Bar & {volume:number}>[], preserving adjusted true/false/absent and
   vwap zero/absent. vectorized.ts504 reads adjusted for corporateAction; VectorizedOptions.data
   is Bar[], so teach data:[...prices.bars] for ownership, not a direct readonly assignment.
   resample.ts accepts ArrayLike and takes interval plus optional options; direct array use is valid.
   No compute signatures/immutability weakened. Future engine parity tests require exact source
   flags and assumptions, in addition to selected numeric data.
4. Safe raw interval framing permits future units1s/1y and named tokens but never interprets them;
   only the finite understood set is queryable. Invalid type/empty/control/duplicate remains error.
5. Shared DataPins.temporal pins interval/convention across live pages, stored windows, checkpoint/
   resume and kit; individually valid midnight and04Z conventions cannot be mixed. Actual source
   stamps/session labels remain separate from observation/availability.

Corrected the malformed primary-source link introduced by the prior text replacement. OHLC
selections/issues/resolve explicitly belong only to price-bar views. Provider maxSessionDays uses
inclusive Gregorian dates, including weekends; maxWindowMs compares inclusive endpoints' elapsed
millisecond difference, no implicit trading calendar. Added exact acceptance cases and concrete
continuation/ownership-copy examples. No runtime/provider/signature/budget changes, PR26 untouched.
Documentation-only rerun results recorded below, not implementation proof.

Re-review verification: documentation conformance25/25, inventory263 surfaces/4675 executable
fences/zero findings, scoped format/diff checks pass. Only docs inventory regenerated. An external
scratch consumer using hash-verified current C4 public SDK types compiles the proposed canonical-Bar
shape's ownership-copy backtest/direct ArrayLike resample examples under strict NodeNext and Bundler;
an @ts-expect-error control proves direct readonly backtest data is rejected. Logs
/tmp/tf-c5-r2-types-{nodenext,bundler}.log. This verifies existing types, not an implemented C5 selector.
Canonical page.timestampConvention is explicitly retained for empty bar pages as well, so first
empty-page temporal pins are restorable; no inference from a nonexistent first row.
No runtime/signature/provider changes or C5 implementation/hosted acceptance claimed.

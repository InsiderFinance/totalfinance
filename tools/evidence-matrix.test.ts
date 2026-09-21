import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Stage 4.7 (FC9, Decision 6) — the evidence matrix as a gate.
 *
 * The completeness spec's FC1–FC8 workstreams closed their checklist rows with `CLOSED <date>: …`
 * sentences that name the test behind each claim. This gate reads those sentences, asserts every
 * test PATH they cite still exists, and then asserts the four evidence classes the FC9 rows demand —
 * golden corpora (FC1–FC6, with the citation each domain's evidence plan names), property /
 * metamorphic suites (one per workstream), differential tests (a composition against its
 * primitives), and mutation harnesses — each by a named, existing test carrying the token that
 * makes it that class. Nothing here is claimed by prose: a class with no named test fails.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TRACKER = 'docs/specs/finance-portfolio-backtesting-completeness.md';
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

interface Evidence {
  workstream: string;
  file: string;
  /** A token the file must carry to be the class it is cited for (case-insensitive). */
  token: RegExp;
  /** What the token proves. */
  why: string;
}

/** Golden corpora — the FC0 evidence plan's per-domain external reference corpus, one per domain. */
const GOLDEN: readonly Evidence[] = [
  {
    workstream: 'FC1 cash flows',
    file: 'packages/valuation/test/cash-flows.test.ts',
    token: /excel|numpy/i,
    why: 'Excel / NumPy-Financial worked cases',
  },
  {
    workstream: 'FC2 valuation/fundamentals',
    file: 'packages/fundamentals/test/periods.test.ts',
    token: /damodaran|sec|accession/i,
    why: 'SEC filing-derived statement fixtures with accession / availability',
  },
  {
    workstream: 'FC3 screening/factors/events',
    file: 'packages/research/test/factors.test.ts',
    token: /direction|sign/i,
    why: 'style-factor sign / direction conventions',
  },
  {
    workstream: 'FC4 performance',
    file: 'packages/performance/test/flow-aware.test.ts',
    token: /dietz|time-weighted|gips/i,
    why: 'GIPS-style TWR and Modified Dietz worked examples',
  },
  {
    workstream: 'FC5 foreign exchange',
    file: 'packages/foreign-exchange/test/foreign-exchange.test.ts',
    token: /covered.interest|triangular/i,
    why: 'covered-interest-parity and triangular closure fixtures',
  },
  {
    workstream: 'FC6 commodities',
    file: 'packages/commodities/test/commodities.test.ts',
    token: /contango|backwardation/i,
    why: 'contango / backwardation term-structure fixtures',
  },
];

/** Property / metamorphic suites — one per workstream. */
const PROPERTY: readonly Evidence[] = [
  {
    workstream: 'FC1',
    file: 'packages/valuation/test/cash-flows.test.ts',
    token: /scal/i,
    why: 'scaling every cash flow scales PV/NPV and leaves IRR unchanged',
  },
  {
    workstream: 'FC2',
    file: 'packages/fundamentals/test/ratios-scores.test.ts',
    token: /metamorphic/i,
    why: 'ratio metamorphic laws',
  },
  {
    workstream: 'FC3',
    file: 'packages/research/test/factors.test.ts',
    token: /metamorphic|invarian/i,
    why: 'factor transformation invariances',
  },
  {
    workstream: 'FC4',
    file: 'packages/performance/test/flow-aware.test.ts',
    token: /parity|equal/i,
    why: 'MWR = dated IRR parity',
  },
  {
    workstream: 'FC5',
    file: 'packages/foreign-exchange/test/foreign-exchange.test.ts',
    token: /triangular|closure|invert/i,
    why: 'triangular closure and inversion',
  },
  {
    workstream: 'FC6',
    file: 'packages/commodities/test/commodities.test.ts',
    token: /decompos|carry/i,
    why: 'carry decomposition identities',
  },
  {
    workstream: 'FC7 ledger',
    file: 'packages/portfolio/test/reconciliation.test.ts',
    token: /reconcil/i,
    why: 'the ledger reconciles to its events',
  },
  {
    workstream: 'FC8 backtesting',
    file: 'packages/backtest/test/engine-properties.test.ts',
    token: /permutation|look-ahead/i,
    why: 'no look-ahead and ordering invariance on every engine',
  },
];

/** Differential tests — a composition against the primitives it composes. */
const DIFFERENTIAL: readonly Evidence[] = [
  {
    workstream: 'FC2 DCF from statements vs the direct DCF',
    file: 'packages/valuation/test/forecasting.test.ts',
    token: /discountedCashFlow\(/,
    why: 'the statement-driven DCF equals the direct DCF of the projected flows',
  },
  {
    workstream: 'FC8 cross-sectional engine vs its ledger',
    file: 'packages/backtest/test/cross-sectional.test.ts',
    token: /reconcil|netAssetValue/i,
    why: 'finalValue equals the ledger NAV',
  },
  {
    workstream: 'FC8 options book vs its ledger',
    file: 'packages/backtest/test/options-book.test.ts',
    token: /reconcil/i,
    why: 'the options book reconciles to its ledger',
  },
  {
    workstream: 'FC8 portfolio engine vs its ledger',
    file: 'packages/backtest/test/portfolio-backtest.test.ts',
    token: /reconcil/i,
    why: 'the portfolio engine reconciles to its ledger',
  },
  {
    workstream: 'FC8 grid vs direct runs',
    file: 'packages/backtest/test/cross-sectional-grid.test.ts',
    token: /direct/i,
    why: 'every child run equals its direct call and the hygiene verdicts equal the direct risk calls',
  },
  {
    workstream: 'FC8 out-of-sample vs direct runs',
    file: 'packages/backtest/test/cross-sectional-folds.test.ts',
    token: /direct/i,
    why: 'every choice equals a direct grid run and every held-out run a direct engine call',
  },
  {
    workstream: 'FC9 operations vs the SDK',
    file: 'tools/transport-parity.test.ts',
    token: /registry|SDK/i,
    why: 'the registry, CLI, HTTP, and MCP results equal the SDK result',
  },
];

/** Mutation harnesses — signs, units, dates, types, null, counts, absurd magnitudes. */
const MUTATION: readonly Evidence[] = [
  {
    workstream:
      'enforcement mutations (unknown key, null, omitted, wrong type, non-finite, invalid literal)',
    file: 'tools/manifest/contract-conformance.test.ts',
    token: /defective|mutation/i,
    why: 'every public boundary measured under the mutation ladder',
  },
  {
    workstream: 'count safety (absurd and unsafe counts)',
    file: 'tools/first-touch/count-safety-sweep.test.ts',
    token: /mutant|absurd/i,
    why: 'unsafe counts are typed refusals, never work or a hang',
  },
  {
    workstream: 'numerical hardening (math)',
    file: 'packages/math/test/hardening-wave.test.ts',
    token: /NaN|Infinity|non-finite/i,
    why: 'non-finite inputs refused at every math boundary',
  },
  {
    workstream: 'garbage inputs at every public boundary',
    file: 'tools/first-touch/garbage-sweep.test.ts',
    token: /garbage|NaN|Infinity/i,
    why: 'NaN, Infinity, and garbage values refused at every first touch',
  },
  {
    workstream: 'finite results at every public boundary',
    file: 'tools/first-touch/finite-results.test.ts',
    token: /finite/i,
    why: 'no public verb returns a non-finite number as a success',
  },
  {
    workstream: 'point-in-time availability (research)',
    file: 'packages/research/test/universe.test.ts',
    token: /availab/i,
    why: 'observations invisible before their availability instant',
  },
  {
    workstream: 'statement periods (fundamentals)',
    file: 'packages/fundamentals/test/periods.test.ts',
    token: /period/i,
    why: 'period eligibility by availability, never by period end',
  },
];

function assertEvidence(rows: readonly Evidence[]): void {
  const missing = rows
    .filter((row) => !existsSync(join(ROOT, row.file)))
    .map((row) => `${row.workstream}: ${row.file}`);
  expect(missing, 'named evidence files that do not exist').toEqual([]);
  const untokened = rows
    .filter((row) => !row.token.test(read(row.file)))
    .map((row) => `${row.workstream}: ${row.file} carries no ${row.token} (${row.why})`);
  expect(untokened, 'named evidence files that are not the class they are cited for').toEqual([]);
}

describe('the evidence matrix (FC9 Decision 6)', () => {
  it('every test path a CLOSED sentence cites still exists', () => {
    const tracker = read(TRACKER);
    const cited = [
      ...new Set(
        [
          ...tracker.matchAll(
            /(packages\/[a-z-]+\/test\/[A-Za-z0-9._/-]+\.test\.ts|tools\/[A-Za-z0-9._/-]+\.test\.ts|docs\/examples\/[A-Za-z0-9._/-]+\.test\.ts)/g,
          ),
        ].map((m) => m[1]!),
      ),
    ];
    expect(cited.length).toBeGreaterThanOrEqual(8);
    expect(cited.filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
    // the CLOSED convention is in use across the workstreams
    expect((tracker.match(/CLOSED 20\d\d-\d\d-\d\d/g) ?? []).length).toBeGreaterThanOrEqual(50);
  });

  it('golden corpora cover FC1–FC6 with the citation each evidence plan names', () => {
    assertEvidence(GOLDEN);
    expect(new Set(GOLDEN.map((g) => g.workstream.slice(0, 3))).size).toBe(6);
  });

  it('a property / metamorphic suite is named for every workstream', () => {
    assertEvidence(PROPERTY);
    expect(PROPERTY.length).toBeGreaterThanOrEqual(8);
  });

  it('differential tests compare compositions with their primitives', () => {
    assertEvidence(DIFFERENTIAL);
  });

  it('mutation harnesses target signs, units, dates, types, null, counts, availability, and periods', () => {
    assertEvidence(MUTATION);
  });
});

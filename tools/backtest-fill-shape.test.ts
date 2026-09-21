import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Stage 4.6 (FC8 exit gate) — the ledger-is-the-truth law as a source scan.
 *
 * `@totalfinance/backtest` declares NO fill, cash, lot, or P&L SHAPE of its own: every engine's fills
 * are `NormalizedFill`s from `@totalfinance/portfolio`, every cash movement and lot is a portfolio
 * event, and every P&L figure comes from the FC7 reducer (`portfolioPnl`, `portfolioTimeline`).
 * This gate walks the package's src and refuses any exported `interface`/`type` whose name reads
 * like one of those shapes unless it is on the frozen allowlist below — each allowlisted name is
 * a REQUEST, a DECISION, a POLICY, or a REPORT ROW, never a ledger fact:
 *
 * - `FillDecision`, `FillRequest`, `FillContext`, `FillModel`, `PartialFillPolicy`: the execution
 *   layer's decision protocol (Decision 7) — what a model answers, not what the ledger records.
 * - `NormalizedFillFromDecisionInput`: the bridge INTO the portfolio's `NormalizedFill`.
 * - `FillModelFixture`, `AssertFillModelConformanceInput`, `FillModelConformanceResult`: the
 *   conformance harness.
 * - `SlippageFillInput`: the legacy cost model's per-fill argument.
 * - `FillPolicy`, `FillRejection`, `FillTerms`: the options and portfolio engines' declared fill
 *   policy, a refusal row, and an adapter's settlement/accrual terms — none carries a quantity,
 *   a price, or a cash amount that the ledger would not also carry.
 * - `TradePnlExplain`: a REPORT ROW explaining a closed options trade from ledger numbers.
 * - `Position`: the legacy single-instrument engine's open-position row (D18 keeps it byte-stable).
 *
 * The list is SHRINK-ONLY: a new name fails here and must either be renamed away from the ledger's
 * vocabulary or be shown to be a request/decision/report and added with its reason.
 */

const SRC_DIR = fileURLToPath(new URL('../packages/backtest/src', import.meta.url));

const LEDGER_VOCABULARY = /(Fill|Cash|Lot|Pnl|PnL|Ledger)/;

const ALLOWED: ReadonlySet<string> = new Set([
  'FillDecision',
  'FillRequest',
  'FillContext',
  'FillModel',
  'PartialFillPolicy',
  'NormalizedFillFromDecisionInput',
  'FillModelFixture',
  'AssertFillModelConformanceInput',
  'FillModelConformanceResult',
  'SlippageFillInput',
  'FillPolicy',
  'FillRejection',
  'FillTerms',
  'TradePnlExplain',
  // Stage 7B.2 slice 3 (2026-09-06): the shared fill sequence's request and decision rows — the
  // result carries the portfolio's NormalizedFill, never a fill shape of its own.
  'FillOrderWithPolicyInput',
  'FillOrderWithPolicyResult',
  // Pre-publish repairs B6 (2026-09-21): the REQUEST row of normalizedFillsFromBacktest — the
  // backtest's trades plus the account, currency and source ids the portfolio's NormalizedFill
  // needs; the result IS the portfolio's NormalizedFill[], never a fill shape of its own.
  'NormalizedFillsFromBacktestInput',
]);

interface Declaration {
  name: string;
  file: string;
}

function scan(): Declaration[] {
  const out: Declaration[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        const text = readFileSync(p, 'utf8');
        for (const m of text.matchAll(/^export (?:interface|type) (\w+)/gm)) {
          out.push({ name: m[1]!, file: relative(SRC_DIR, p) });
        }
      }
    }
  };
  walk(SRC_DIR);
  return out;
}

describe('@totalfinance/backtest declares no fill, cash, lot, or P&L shape of its own', () => {
  const declarations = scan();

  it('finds the package', () => {
    expect(declarations.length).toBeGreaterThan(50);
  });

  it('every ledger-vocabulary export is a request, decision, policy, or report row on the allowlist', () => {
    const offenders = declarations
      .filter((d) => LEDGER_VOCABULARY.test(d.name) && !ALLOWED.has(d.name))
      .map((d) => `${d.name} (${d.file})`);
    expect(offenders).toEqual([]);
  });

  it('the allowlist only shrinks — every entry is still declared', () => {
    const declared = new Set(declarations.map((d) => d.name));
    const stale = [...ALLOWED].filter((name) => !declared.has(name));
    expect(stale).toEqual([]);
  });

  it('every engine result types its fills as the portfolio NormalizedFill', () => {
    const results = declarations.filter(
      (d) => /BacktestResult$/.test(d.name) && d.name !== 'BacktestResult',
    );
    expect(results.map((d) => d.name).sort()).toEqual(
      ['CrossSectionalBacktestResult', 'OptionsBacktestResult', 'PortfolioBacktestResult'].sort(),
    );
    for (const result of results) {
      const text = readFileSync(join(SRC_DIR, result.file), 'utf8');
      const block = text.slice(text.indexOf(`export interface ${result.name}`));
      const body = block.slice(0, block.indexOf('\n}\n'));
      expect(body, `${result.name} must carry \`fills: NormalizedFill[]\``).toMatch(
        /fills: NormalizedFill\[\];/,
      );
      expect(body, `${result.name} must carry the ledger snapshot`).toMatch(
        /ledger: PortfolioLedgerSnapshot;/,
      );
    }
  });
});

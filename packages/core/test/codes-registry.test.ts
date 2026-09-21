/**
 * WS2.9 — the ErrorCode and WarningCode registries are hygienic: no string value is duplicated
 * within a registry, and no string appears in BOTH (a code that is both a thrown error and an
 * emitted warning lives only in ErrorCode, and warning sites reference ErrorCode.* for the string).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ErrorCode, WarningCode, wrongShapeError } from '@totalfinance/core';

describe('code registries (WS2.9)', () => {
  it('ErrorCode has no duplicate string values', () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });

  it('WarningCode has no duplicate string values', () => {
    const values = Object.values(WarningCode);
    expect(new Set(values).size).toBe(values.length);
  });

  it('no code string appears in BOTH registries', () => {
    const errStrings = new Set<string>(Object.values(ErrorCode));
    const shared = Object.values(WarningCode).filter((v) => errStrings.has(v));
    expect(shared).toEqual([]);
  });

  it('the WS2.9 codes are registered', () => {
    expect(ErrorCode.LinalgNotPositiveDefinite).toBe('linalg.not_positive_definite');
    expect(ErrorCode.LinalgSingular).toBe('linalg.singular');
    expect(ErrorCode.InterpolationDuplicateKnots).toBe('interpolation.duplicate_knots');
    expect(ErrorCode.InterpolationInvalidGrid).toBe('interpolation.invalid_grid');
    expect(ErrorCode.VolatilityExpiryNotFound).toBe('volatility.expiry_not_found');
    expect(ErrorCode.StrategyInvalidChartRange).toBe('strategy.invalid_chart_range');
  });

  it('the shared-scenario runner codes are registered centrally', () => {
    expect(ErrorCode.ScenarioInstructionUnmatched).toBe('scenario.instruction_unmatched');
    expect(ErrorCode.ScenarioTargetUnsupported).toBe('scenario.target_unsupported');
    expect(ErrorCode.ScenarioCellFailed).toBe('scenario.cell_failed');
    expect(WarningCode.ScenarioUnusedCurrencyConversion).toBe(
      'scenario.unused_currency_conversion',
    );
  });

  // F15 — @totalfinance/core OWNS the registry, so it must practise what it preaches: no `code:` string
  // literal in core src may bypass ErrorCode/WarningCode (other packages may introduce their own codes;
  // this discipline is enforced only where the registry lives). This caught the raw time-zone code.
  it('core itself emits only registered codes (no raw `code:` literals)', () => {
    const registered = new Set<string>([
      ...Object.values(ErrorCode),
      ...Object.values(WarningCode),
    ]);
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const raw: string[] = [];
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(`${srcDir}/${file}`, 'utf8');
      for (const m of text.matchAll(/code:\s*'([a-z][a-z0-9_.]+)'/g)) {
        if (!registered.has(m[1]!)) raw.push(`${file}: '${m[1]}'`);
      }
    }
    expect(
      raw,
      `core uses unregistered raw codes — add them to ErrorCode/WarningCode:\n${raw.join('\n')}`,
    ).toEqual([]);
  });

  it('the newly-registered codes exist and wrongShapeError is a shape error, not missing-field (F15)', () => {
    expect(ErrorCode.TimeTimezoneResolutionFailed).toBe('time.timezone_resolution_failed');
    expect(ErrorCode.InputWrongShape).toBe('input.wrong_shape');
    // A wrong-shape object gets its own code — distinct from `input.missing_field`.
    const err = wrongShapeError('legs.call', 'an OptionLegInput', { wrongKey: 1 });
    expect(err.code).toBe(ErrorCode.InputWrongShape);
    expect(err.code).not.toBe(ErrorCode.InputMissingField);
  });
});

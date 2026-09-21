import { bench, describe } from 'vitest';
import { covarianceMatrix, mean, standardDeviation, variance } from '@totalfinance/math';
// Package-private on purpose: the validated-body helpers are not on the exports map. A benchmark
// inside the package is exactly where the boundary/internal pair may be compared.
import { covarianceValidated } from '../src/statistics-internal.js';

/**
 * Statistics boundary-validation evidence (spec 3B.1b, review of 52f4e422e).
 *
 * The first Law-12 pass validated options on EVERY internal frame (`standardDeviation → variance →
 * mean → sum`), defaulted `options = {}` so the validator's `undefined` fast path never ran, and
 * called `Object.keys(fields)` per invocation. A repeated local microbenchmark against the parent
 * commit measured 500k eight-value `standardDeviation` calls at ~3.6x the parent, and 5k 12×24
 * `covarianceMatrix` calls ~35% slower — which conclusively disproved the comment that revalidation
 * "costs nothing". The architecture is now: the public boundary validates ONCE, internal delegation
 * goes through package-private helpers, and the no-options path is a single `undefined` comparison.
 *
 * These are the committed cases for that claim. The A/B pairs put a number on what one boundary
 * validation costs — and what NOT paying it per frame buys back. Read the rme before quoting
 * anything (a figure taken under load has been wrong here before), and compare within one run,
 * never across machines.
 */
const SMALL = [3, 1, 4, 1, 5, 9, 2, 6];

const ROWS = 100_000;
const wide = new Float64Array(ROWS);
for (let i = 0; i < ROWS; i++) wide[i] = Math.sin(i) * 10 + (i % 7);

const VARIABLES = 12;
const OBSERVATIONS = 24;
const panel: number[][] = Array.from({ length: VARIABLES }, (_, v) =>
  Array.from({ length: OBSERVATIONS }, (_, t) => Math.sin(v + t) * 5 + ((v * t) % 5)),
);

describe('scalar boundary cost (8 values — validation-dominated on purpose)', () => {
  bench('standardDeviation, no options (undefined fast path)', () => {
    standardDeviation(SMALL);
  });

  bench('standardDeviation, options provided (one validation)', () => {
    standardDeviation(SMALL, { population: true });
  });

  bench('mean, no options', () => {
    mean(SMALL);
  });
});

describe('100k-row reduction (validation amortized to nothing)', () => {
  bench('variance over 100k rows, no options', () => {
    variance(wide);
  });

  bench('variance over 100k rows, options provided', () => {
    variance(wide, { population: true });
  });
});

describe('covarianceMatrix 12×24 (per-pair delegation must not revalidate)', () => {
  bench('covarianceMatrix, public boundary (validates once)', () => {
    covarianceMatrix(panel, { population: true });
  });

  bench('pairwise covarianceValidated only (the internal path the loop takes)', () => {
    for (let i = 0; i < VARIABLES; i++) {
      for (let j = i; j < VARIABLES; j++) {
        covarianceValidated(panel[i]!, panel[j]!, { population: true }, 'bench');
      }
    }
  });
});

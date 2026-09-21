/**
 * `@totalfinance/options/lattice` — the payoff-agnostic equity binomial lattice kernel as a lean
 * expert subpath (P3.1b kernels-off-roots). The implementation lives in `equity-lattice.ts`;
 * this shim exists because subpath names mirror source filenames across the monorepo tooling.
 */
export * from './equity-lattice.js';

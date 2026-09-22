/**
 * `@insiderfinance/totalfinance/options` — option contracts, pricing engines, Greeks, and implied volatility.
 * Browser-safe, zero runtime dependencies.
 *
 * Two API shapes (design law #1):
 *   - facade: `import { blackScholes } from '@insiderfinance/totalfinance/options'` → flat args, plain values, `.explain()`.
 *   - pro:    `import { option, market, engines } from '@insiderfinance/totalfinance/options'` → rich envelopes.
 *
 * Hot path: `import { blackScholes } from '@insiderfinance/totalfinance/options/black-scholes'` for the leanest bundle.
 */

export { blackScholes } from './black-scholes.js';
export { optionChainHealth } from './chain-health.js';
export type {
  OptionChainHealthQuote,
  OptionChainHealthMarket,
  OptionChainHealthModelMarket,
  OptionChainHealthConfig,
  OptionChainHealthInput,
  OptionChainHealthIssue,
  OptionChainHealthModelStatus,
  OptionChainHealthModelResult,
  OptionChainHealthContract,
  OptionChainHealthRow,
  OptionChainHealthExpiryCoverage,
  OptionChainHealthReport,
} from './chain-health.js';
export type { Facade } from './facade-util.js';

export { black76 } from './black76.js';
export type {
  Black76Input,
  Black76TypedInput,
  Black76ImpliedVolatilityInput,
  Black76ImpliedVolatilityResult,
} from './black76.js';
// Kernels black76Price/black76Greeks/… live on the expert subpath `@insiderfinance/totalfinance/options/black76`.

export { bachelier } from './bachelier.js';
export type {
  BachelierInput,
  BachelierTypedInput,
  BachelierImpliedVolatilityInput,
  BachelierImpliedVolatilityResult,
} from './bachelier.js';
// Kernels bachelierPrice/… live on the expert subpath `@insiderfinance/totalfinance/options/bachelier`.

export { option, priceOption, impliedVolatilityOption } from './pro.js';
// 3B.2 nameability: the request types of the professional heads, exported so a consumer can
// declare `const request: PriceOptionInput = {...}` instead of satisfying the shape by accident.
export type { PriceOptionInput, ImpliedVolatilityOptionInput } from './pro.js';
export { market } from './market.js';
export {
  engines,
  defineOptionPricingEngine,
  validateOptionPricingEngine,
  compareEngines,
} from './engines.js';
export type {
  OptionPricingEngine,
  OptionPricingEngineProbe,
  PriceOptions,
  BinomialEngineOptions,
  TrinomialEngineOptions,
  FiniteDifferenceEngineOptions,
  AutoObjective,
  AutoEngineOptions,
  EngineComparison,
  EngineComparisonRow,
  CompareEnginesInput,
  OptionEnginePriceInput,
} from './engines.js';
export type { BinomialVariant } from './engines/tree.js';

// Monte-Carlo / quasi-Monte-Carlo European pricing (spec §8.6, §9.3). The flat kernels
// (monteCarloPrice, monteCarloEuropean) moved to '@insiderfinance/totalfinance/options/monte-carlo' (P3.1b
// kernels-off-roots); the curated `gbm` namespace remains the root surface.
export { gbm } from './monte-carlo.js';
export type { GbmPathInput, GbmTerminalInput } from './monte-carlo.js';
export type {
  MonteCarloPriceOptions,
  MonteCarloPriceResult,
  MonteCarloMethod,
  MonteCarloRandomNumberGenerator,
  MonteCarloStatistics,
  MonteCarloEstimate,
  MonteCarloSamplingOptions,
  VarianceReduction,
  ControlVariate,
} from './monte-carlo.js';

// Heston stochastic-volatility model — COS analytic + QE Monte-Carlo (spec §9.3, §10.1).
export { heston } from './heston.js';
export type {
  HestonParameters,
  HestonInput,
  HestonCosineExpansionOptions,
  HestonMonteCarloOptions,
  HestonMonteCarloResult,
} from './heston.js';

// SABR model — Hagan asymptotics + SDE Monte-Carlo (spec §9.3, §10.1).
export { sabr } from './sabr.js';
export type {
  SabrParameters,
  SabrVolatilityType,
  SabrInput,
  SabrOptions,
  SabrMonteCarloOptions,
  SabrMonteCarloResult,
} from './sabr.js';

// Dupire local volatility — surface extraction + grid-cached Monte-Carlo (spec §9.3, §10.1).
export { localVolatility } from './local-volatility.js';
export type {
  ImpliedVolatilityFunction,
  LocalVolatilityFunction,
  LocalVolatilityMarket,
  DupireOptions,
  LocalVolatilityGridSpecification,
  LocalVolatilityInput,
  LocalVolatilityMonteCarloOptions,
  LocalVolatilityMonteCarloResult,
} from './local-volatility.js';

// Exotic engines — barrier, Asian, lookback, spread, quanto, basket, rainbow, autocallable,
// variance/volatility swaps (analytic + Monte-Carlo) (spec §9.3).
export {
  barrier,
  asian,
  lookback,
  spread,
  quanto,
  basket,
  rainbow,
  autocallable,
  varianceSwap,
  volatilitySwap,
  digital,
  touch,
  doubleTouch,
  forwardStart,
  cliquet,
  napoleon,
  reverseCliquet,
  compo,
  inverseOption,
} from './exotics.js';
export type {
  ExoticResult,
  ExoticMonteCarloResult,
  BarrierType,
  BarrierInput,
  BarrierMonteCarloOptions,
  AsianInput,
  AsianMonteCarloInput,
  AsianMonteCarloOptions,
  LookbackStrike,
  LookbackInput,
  LookbackMonteCarloOptions,
  SpreadInput,
  QuantoInput,
  MultiAssetInput,
  BasketInput,
  RainbowKind,
  AutocallableInput,
  DigitalKind,
  DigitalInput,
  TouchKind,
  TouchInput,
  TouchMonteCarloOptions,
  DoubleTouchKind,
  DoubleTouchInput,
  ForwardStartInput,
  CliquetInput,
  NapoleonInput,
  ReverseCliquetInput,
  CompoInput,
  CompoGreeks,
  CompoMonteCarloOptions,
  InverseOptionInput,
  InverseGreeks,
  InverseOptionMonteCarloOptions,
} from './exotics.js';

// Generic equity binomial lattice types (spec §9 lattice tooling). The `equityLattice`
// kernel itself moved to '@insiderfinance/totalfinance/options/lattice' (P3.1b kernels-off-roots).
export type {
  EquityLattice,
  EquityLatticeOptions,
  LatticeNode,
  LatticeVariant,
} from './equity-lattice.js';

export {
  callContract,
  putContract,
  european,
  usEquityCall,
  usEquityPut,
  usEquityOption,
} from './contract.js';
export type { UsEquityOptionInput } from './contract.js';
// B7: the Greeks call that exists — solves every chain row from its observed price.
export { chainGreeks } from './chain-greeks.js';
export type {
  ChainGreeksInput,
  ChainGreeksResult,
  ChainGreeksDiagnostics,
  ChainGreeksRowDiagnostic,
  ChainGreeksRowStatus,
  ChainGreeksAssumptionsExtra,
} from './chain-greeks.js';
export type { OptionBuilderInput, InstrumentBuilderInput } from './contract.js';

// Batch pricing (spec §9.6).
export { priceMany } from './batch.js';
// Batch kernels blackScholesPriceMany/blackScholesPriceManyInto/blackScholesImpliedVolatilityMany: `@insiderfinance/totalfinance/options/black-scholes`.
export type {
  OptionBatchColumns,
  OptionBatchResult,
  OptionImpliedVolatilityBatchColumns,
  OptionImpliedVolatilityBatchResult,
  PriceManyInput,
} from './batch.js';

// Expiration payoff primitives (`@insiderfinance/totalfinance/options/payoff`): the standalone vanilla intrinsic —
// gross value per unit, model-free, deliberately not P&L (that stays on Position.pnlAtExpiry).
export { vanillaIntrinsic } from './payoff.js';
export type { VanillaIntrinsicInput } from './payoff.js';

// No-arbitrage checks and quote price-source selection (boundary-guarded over the core kernel).
export { checkBlackScholesNoArbitrage } from './arbitrage.js';
export type { BlackScholesNoArbitrageInput } from './arbitrage.js';
export { selectQuotePrice } from './quote.js';
// 3B.2 nameability: selectQuotePrice takes core's OptionQuote — nameable from THIS package.
export type { OptionQuote } from '@totalfinance/core';
export type { PriceSource } from '@totalfinance/core';

// Put-call parity / implied carry from a snapshot chain (spec §WS9.4).
export {
  impliedForward,
  impliedDividendYield,
  impliedBorrow,
  boxSpreadRate,
  ParityCode,
  DEFAULT_OUTLIER_THRESHOLD,
} from './parity.js';
export type {
  ParityResult,
  ParityDiagnostics,
  ParityAssumptions,
  ParityStrikeResidual,
  BoxSpreadResult,
  BoxSpreadDiagnostics,
  BoxSpreadAssumptions,
  ImpliedForwardOptions,
  ImpliedDividendYieldOptions,
  ImpliedBorrowOptions,
  BoxSpreadOptions,
} from './parity.js';

// Implied-volatility method suite (spec §9.5).
export { impliedVolatility, impliedVolatilityMany } from './iv.js';
export type {
  ImpliedVolatilityMethod,
  ImpliedVolatilityOptions,
  ImpliedVolatilitySolveResult,
  ImpliedVolatilityDiagnostics,
} from './iv.js';
export { americanImpliedVolatility } from './american-iv.js';
export type {
  AmericanImpliedVolatilityOptions,
  AmericanImpliedVolatilityInput,
} from './american-iv.js';
// American exercise analytics: early-exercise premium decomposition + exercise boundary S*(τ).
export { americanExercise } from './exercise.js';
export type {
  AmericanExerciseOptions,
  AmericanExerciseResult,
  BoundaryPoint,
  AmericanExerciseInput,
} from './exercise.js';
// Dividend term structures: discrete schedule + continuous yield unified into per-expiry
// forward / dividend-PV / continuous-equivalent yield q_eff(T).
export { dividendTermStructure } from './dividend-term-structure.js';
export type {
  DividendTermStructureInput,
  DividendTermStructurePoint,
  DividendTermStructure,
} from './dividend-term-structure.js';

// Low-level kernel, for advanced users and engine authors.
// Kernels blackScholesPrice/blackScholesGreeks/… live on the expert subpath `@insiderfinance/totalfinance/options/black-scholes`.
export type {
  BlackScholesImpliedVolatilityResult,
  BlackScholesImpliedVolatilityOptions,
  ImpliedVolatilityReason,
} from './bsm.js';

export type {
  Greeks,
  ExtendedGreeks,
  DiscreteDividend,
  BlackScholesInput,
  BlackScholesTypedInput,
  BlackScholesImpliedVolatilityInput,
  OptionMarket,
  PriceResult,
  ImpliedVolatilityResult,
} from './types.js';

// Runtime schemas (spec §6) — re-exported here as a convenience on the aggregate entrypoint.
// Bundlers tree-shake them when unused; for a guaranteed schema-free footprint import the deep
// `@insiderfinance/totalfinance/options/black-scholes` entrypoint (the hot path, enforced by the bundle-size test).
export {
  schemas,
  BlackScholesInputSchema,
  BlackScholesTypedInputSchema,
  BlackScholesImpliedVolatilityInputSchema,
  OptionContractSchema,
} from './schema.js';

// Canonical contract types live in core; re-exported for convenience.
export type { OptionContract, OptionType, OptionStyle } from '@totalfinance/core';

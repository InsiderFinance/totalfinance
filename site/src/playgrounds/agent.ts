/**
 * "Ask your AI agent": for each calculator, the MCP tool that performs the same calculation and a
 * ready prompt built from the reader's current inputs. Tool names and profiles are checked against
 * the generated operation catalog in `test/agents.test.ts`.
 */
import type { PlaygroundInput } from '../types';

export interface CalculatorAgent {
  /** Operation id in the catalog; null when the task is SDK code rather than one MCP tool. */
  operation: string | null;
  /** MCP server profile that exposes the operation; null for the default profile. */
  profile: string | null;
  prompt(input: PlaygroundInput): string;
}

type Row = Record<string, unknown>;
const value = (input: PlaygroundInput, key: string) => (input as Record<string, unknown>)[key];
const number = (input: PlaygroundInput, key: string) => Number(value(input, key));
const text = (input: PlaygroundInput, key: string) => String(value(input, key));
const rows = (input: PlaygroundInput, key: string) =>
  (value(input, key) as Row[] | undefined) ?? [];
/** Decimal to a readable percent: 0.2 → "20%", 0.045 → "4.5%". */
const percent = (decimal: number) => `${Number((decimal * 100).toFixed(4))}%`;
const amount = (usd: number) => usd.toLocaleString('en-US', { maximumFractionDigits: 2 });

const PASTE_BARS = '\n\n[Paste your daily OHLCV CSV here: date, open, high, low, close, volume]';
const PASTE_RETURNS = '\n\n[Paste your daily returns here, one decimal per line: 0.01 = 1%]';

export const CALCULATOR_AGENTS: Record<string, CalculatorAgent> = {
  'price-an-option': {
    operation: 'totalfinance.option.price',
    profile: null,
    prompt: (input) =>
      `Use the TotalFinance MCP tool totalfinance_option_price to price a European ${text(input, 'type')}: spot ${number(input, 'spot')}, strike ${number(input, 'strike')}, ${number(input, 'timeToExpiryYears')} years to expiry, volatility ${percent(number(input, 'volatility'))}, risk-free rate ${percent(number(input, 'riskFreeRate'))}, dividend yield ${percent(number(input, 'dividendYield'))}. Then get the Greeks with totalfinance_option_greeks and list the assumptions the tools report.`,
  },
  'analyze-a-strategy': {
    operation: 'totalfinance.strategy.analyze',
    profile: null,
    prompt: (input) => {
      const legs = rows(input, 'legs').map((leg) => {
        const quantity = Number(leg['quantity']);
        const side = quantity < 0 ? 'short' : 'long';
        const what =
          leg['type'] === 'stock'
            ? `${Math.abs(quantity)} shares at ${leg['strike']}`
            : `${Math.abs(quantity)} ${leg['type']} strike ${leg['strike']} premium ${leg['premium']}`;
        return `${side} ${what}`;
      });
      return `Use the TotalFinance MCP tool totalfinance_strategy_analyze on this position: ${legs.join('; ')}. Report the breakevens, net debit or credit, maximum profit and maximum loss.`;
    },
  },
  'track-portfolio-pnl': {
    operation: 'totalfinance.portfolio.explain_pnl',
    profile: 'portfolio',
    prompt: (input) =>
      `Use the TotalFinance MCP tool totalfinance_portfolio_explain_pnl: I bought ${number(input, 'quantity')} shares at ${amount(number(input, 'openingPrice'))} USD, deposited ${amount(number(input, 'deposit'))} USD later, and the shares are now marked at ${amount(number(input, 'closingPrice'))} USD. Separate the deposit from the investment return and show how the components reconcile.`,
  },
  'value-a-company': {
    operation: null,
    profile: null,
    prompt: (input) =>
      `Using the TotalFinance docs MCP, read the reference for discountedCashFlow, then write TypeScript with @insiderfinance/totalfinance that values a company whose first-year free cash flow is ${amount(number(input, 'firstCashFlow'))} USD growing ${percent(number(input, 'growthRate'))} a year, discounted at ${percent(number(input, 'annualDiscountRate'))} with ${percent(number(input, 'perpetualGrowthRate'))} perpetual growth. Show the assumptions the result reports.`,
  },
  'backtest-a-strategy': {
    operation: 'totalfinance.backtest.vectorized_run',
    profile: 'backtesting',
    prompt: (input) => {
      const rule =
        text(input, 'rule') === 'average-crossover'
          ? `hold while the ${number(input, 'fastPeriod')}-day moving average is above the ${number(input, 'slowPeriod')}-day average`
          : `hold while the close is above its ${number(input, 'fastPeriod')}-day moving average`;
      return `Use the TotalFinance MCP tool totalfinance_backtest_vectorized_run to backtest this rule on my daily bars: ${rule}. Start with ${amount(number(input, 'initialCapital'))} USD and ${number(input, 'feeBasisPoints')} basis points per trade. Report the final value, turnover and drawdown, and every policy the run assumed.${PASTE_BARS}`;
    },
  },
  'explore-scenarios': {
    operation: 'totalfinance.scenario.run',
    profile: 'scenarios',
    prompt: (input) =>
      `Use the TotalFinance MCP tool totalfinance_scenario_run to revalue a 100/110 bull call spread across a grid of underlying-price and volatility shocks: starting price ${number(input, 'spot')}, volatility ${percent(number(input, 'volatility'))}, valued ${number(input, 'daysForward')} calendar days forward, risk-free rate ${percent(number(input, 'riskFreeRate'))}. Report the worst and best cells of the P&L grid.`,
  },
  'chart-technical-indicators': {
    operation: 'totalfinance.technical_analysis.calculate',
    profile: null,
    prompt: (input) => {
      const overlay = text(input, 'overlay');
      const overlayText =
        overlay === 'bollinger'
          ? `Bollinger Bands (${number(input, 'overlayPeriod')} bars, ${number(input, 'bandWidth')} standard deviations)`
          : `${overlay.toUpperCase()} (${number(input, 'overlayPeriod')} bars)`;
      const oscillator =
        text(input, 'oscillator') === 'macd'
          ? 'MACD (12, 26, 9)'
          : `RSI (${number(input, 'rsiPeriod')} bars)`;
      return `Use the TotalFinance MCP tool totalfinance_technical_analysis_calculate on my bars for ${overlayText} and ${oscillator}. Tell me how many warm-up bars have no value and what the latest readings are.${PASTE_BARS}`;
    },
  },
  'measure-risk': {
    operation: 'totalfinance.risk.value_at_risk',
    profile: null,
    prompt: (input) =>
      `Use the TotalFinance MCP tool totalfinance_risk_value_at_risk with the ${text(input, 'method')} method at ${percent(number(input, 'confidence'))} confidence on my daily returns, then totalfinance_performance_analyze with ${number(input, 'periodsPerYear')} periods per year for volatility and drawdown. Explain what the VaR and expected shortfall mean in plain words.${PASTE_RETURNS}`,
  },
  'price-a-bond': {
    operation: 'totalfinance.fixed_income.bond_analytics',
    profile: null,
    prompt: (input) =>
      `Use the TotalFinance MCP tool totalfinance_fixed_income_bond_analytics for a ${number(input, 'years')}-year bond with a ${percent(number(input, 'couponRate'))} annual coupon paid ${text(input, 'frequency')}, priced at a ${percent(number(input, 'yield'))} yield. Report the price, durations and convexity, and what a 1% yield rise would do to the price.`,
  },
  'fit-a-volatility-smile': {
    operation: 'totalfinance.volatility.surface',
    profile: null,
    prompt: (input) => {
      const quotes = rows(input, 'quotes')
        .map((quote) => `${quote['strike']}: ${percent(Number(quote['impliedVolatility']))}`)
        .join(', ');
      return `Use the TotalFinance MCP tool totalfinance_volatility_surface to fit a ${text(input, 'model').toUpperCase()} smile to these implied volatilities by strike (spot ${number(input, 'spot')}, risk-free rate ${percent(number(input, 'riskFreeRate'))}): ${quotes}. Report the fit quality and any arbitrage violations.`;
    },
  },
};

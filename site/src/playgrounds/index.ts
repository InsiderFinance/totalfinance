import { options } from './options.js';
import { strategies } from './strategy.js';
import { portfolio } from './portfolio.js';
import { valuation } from './valuation.js';
import { backtesting } from './backtest.js';
import { scenarios } from './scenario.js';

/** Build/test inventory. The browser uses lazy imports, never this eager module. */
export const playgrounds = [options, strategies, portfolio, valuation, backtesting, scenarios];

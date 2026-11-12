import { options } from './options';
import { strategies } from './strategy';
import { portfolio } from './portfolio';
import { valuation } from './valuation';
import { backtesting } from './backtest';
import { scenarios } from './scenario';
import { indicators } from './indicators';
import { risk } from './risk';
import { bond } from './bond';
import { smile } from './smile';

/** Build/test inventory, in reading order. The browser uses lazy imports, never this eager module. */
export const playgrounds = [
  options,
  strategies,
  portfolio,
  valuation,
  backtesting,
  scenarios,
  indicators,
  risk,
  bond,
  smile,
];

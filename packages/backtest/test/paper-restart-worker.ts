/** Separate-process journal continuation used by the R06/R07 regression. No shared module state. */
import { readFileSync } from 'node:fs';
import { execution } from '@totalfinance/backtest/execution';
import {
  createPaperBroker,
  type CreatePaperBrokerInput,
  type PaperStepInput,
  type PaperSubmitInput,
} from '@totalfinance/backtest/paper';

const input = JSON.parse(readFileSync(0, 'utf8')) as {
  journal: CreatePaperBrokerInput['journal'];
  submit: PaperSubmitInput;
  step: PaperStepInput;
};
const broker = createPaperBroker({
  sourceId: 'paper:main',
  accountId: 'main',
  baseCurrency: 'USD',
  ...(input.journal === undefined ? {} : { journal: input.journal }),
  execution: execution.declared({ label: 'quarter volume', costs: { participation: 0.25 } }),
});
const receipt = broker.submit(input.submit);
const result = broker.step(input.step);
process.stdout.write(JSON.stringify({ receipt, result, journal: broker.journal() }));

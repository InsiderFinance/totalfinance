/** Real process boundary for trade-transactions.test.ts. No mocked journal or approval path. */
import type {
  ExecutionReceipt,
  PaperInstrument,
  PaperStepInput,
  PaperStepResult,
  PaperSubmitInput,
} from '@totalfinance/backtest/paper';
import type { ExecutionJournalEvent } from '@totalfinance/portfolio/trade';
import { createOperationRegistry, tradePack } from '@totalfinance/workflows';
import {
  createFileAuthorizationStore,
  createFileExecutionJournalStore,
} from '@totalfinance/workflows/local';

export interface TradeSubmission extends Omit<PaperSubmitInput, 'grant'> {
  grantHash: string;
  sourceId: string;
  accountId: string;
  baseCurrency: string;
  instruments?: Record<string, PaperInstrument>;
  observations?: PaperStepInput['observations'];
  asOf?: number;
}

export interface TradeSubmissionResult extends Omit<PaperStepResult, 'asOf' | 'journal'> {
  receipt: ExecutionReceipt;
  retried: boolean;
  journal: { journalId: string; appended: number; total: number };
}

export type TradeWorkerOutcome =
  | {
      kind: 'completed';
      pid: number;
      result: TradeSubmissionResult;
      /** Read AFTER registry.run returns, proving the acknowledged facts were committed. */
      committed: ExecutionJournalEvent[];
    }
  | { kind: 'refused'; pid: number; error: { code: string | null; message: string } };

export type TradeWorkerMessage = { kind: 'ready'; pid: number } | TradeWorkerOutcome;

const directory = process.argv[2];
if (!directory || !process.send) throw new Error('worker requires a store directory and IPC');
const registry = createOperationRegistry({ packs: [tradePack()] });
const stores = {
  authorization: createFileAuthorizationStore({ directory }),
  journal: createFileExecutionJournalStore({ directory }),
};

process.once('message', (input: TradeSubmission) => {
  let outcome: TradeWorkerOutcome;
  try {
    const result = registry.run({
      id: 'totalfinance.trade.submit',
      input,
      stores,
      // Deliberately unable to mint a grant: only the trusted parent approves.
      capabilities: ['trade:paper'],
      createdTimestampMs: Date.parse('2026-09-07T12:00:00Z'),
    }).structured as unknown as TradeSubmissionResult;
    outcome = {
      kind: 'completed',
      pid: process.pid,
      result,
      committed: stores.journal.read(`${input.sourceId}:journal`),
    };
  } catch (error) {
    outcome = {
      kind: 'refused',
      pid: process.pid,
      error: {
        code:
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : null,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  process.send!(outcome, (error) => {
    if (error) process.exitCode = 1;
    process.disconnect();
  });
});
process.send({ kind: 'ready', pid: process.pid } satisfies TradeWorkerMessage);

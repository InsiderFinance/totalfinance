/** Bundled from source by the regression suite; each invocation is an independent Node process. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { parentPort } from 'node:worker_threads';
import {
  createFileArtifactStore,
  createFileAuthorizationStore,
  createFileExecutionJournalStore,
  createFileJobStore,
} from '@totalfinance/workflows/local';
import { CREATED, JOURNAL, event, grant, job } from './store-values.js';

const [action, directory, workerText, countText] = process.argv.slice(2);
const worker = Number(workerText);
const count = Number(countText);
if (!directory) throw new Error('worker directory required');
const journal = createFileExecutionJournalStore({ directory });
const artifacts = createFileArtifactStore({ directory });
const authorizations = createFileAuthorizationStore({ directory });
const jobs = createFileJobStore({ directory });
const results: unknown[] = [];
const channel = parentPort ?? process;
const send = (message: unknown, finish = false): void => {
  if (parentPort) {
    parentPort.postMessage(message);
    if (finish) parentPort.close();
  } else {
    // Wait for the complete IPC write before disconnecting. Large result batches otherwise
    // lose their reply on the minimum Node runtime and masquerade as a store deadlock.
    process.send?.(message as object, (error) => {
      if (error) process.exitCode = 1;
      if (finish && process.connected) process.disconnect();
    });
  }
};

// Stop a real writer at the two sides of its journal rename; the parent kills the process.
// This leaves actual abandoned lock registers and (before rename) a synced orphan temp file.
if (action?.startsWith('crash-')) {
  const rename = fs.renameSync;
  fs.renameSync = (oldPath, newPath) => {
    const journalWrite = String(newPath).includes('/journals/v2/');
    const indexWrite =
      (action === 'crash-artifact-index' && String(newPath).endsWith('/artifacts/index.json')) ||
      (action === 'crash-authorization-index' &&
        String(newPath).endsWith('/authorizations/index.json'));
    if ((journalWrite && action === 'crash-before-rename') || indexWrite) {
      send('held');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    rename(oldPath, newPath);
    if (journalWrite && action === 'crash-after-rename') {
      send('held');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  };
  syncBuiltinESMExports();
}

channel.once('message', () => {
  try {
    for (let index = 0; index < count; index += 1) {
      switch (action) {
        case 'large-reply':
          results.push({ payload: 'x'.repeat(256 * 1024) });
          break;
        case 'crash-artifact-index':
          artifacts.put({ kind: 'report', value: { id: 'orphan' }, createdTimestampMs: CREATED });
          break;
        case 'crash-authorization-index':
          authorizations.put({ grant: grant('orphan'), createdTimestampMs: CREATED });
          break;
        case 'crash-before-rename':
        case 'crash-after-rename':
          journal.append({ events: [event('crash-batch-1'), event('crash-batch-2')] });
          break;
        case 'append':
          results.push(journal.append({ events: [event(`${worker}:${index}`)] }));
          break;
        case 'allocate':
          results.push(
            journal.transact({
              journalId: JOURNAL,
              execute: (prior) => ({
                events: [event(`allocated:${prior.length}`)],
                result: prior.length,
              }),
            }),
          );
          break;
        case 'duplicate':
          results.push(journal.append({ events: [event('retry')] }));
          break;
        case 'conflict':
          results.push(
            journal.append({
              events: [{ ...event('retry'), detail: { note: String(worker % 2) } }],
            }),
          );
          break;
        case 'indexes': {
          const id = `${worker}:${index}`;
          results.push(
            artifacts.put({ kind: 'report', value: { id }, createdTimestampMs: CREATED }),
          );
          results.push(authorizations.put({ grant: grant(id), createdTimestampMs: CREATED }));
          break;
        }
        case 'index-retry':
          results.push(
            artifacts.put({
              kind: 'report',
              value: { id: 'same' },
              createdTimestampMs: Date.parse(`2026-09-0${worker + 1}T12:00:00Z`),
            }),
          );
          results.push(
            authorizations.put({
              grant: grant('same'),
              createdTimestampMs: Date.parse(`2026-09-0${worker + 1}T12:00:00Z`),
            }),
          );
          break;
        case 'job-create':
          results.push(jobs.create(job()));
          break;
        case 'job-immutable':
          results.push(
            jobs.update(
              'job-1',
              worker === 0
                ? { inputsHash: 'valid-update' }
                : ({ id: `renamed-${worker}` } as never),
            ),
          );
          break;
        case 'job-update':
          results.push(
            jobs.update(
              'job-1',
              [
                { seed: index },
                { progress: { stage: 'working', fraction: index / count } },
                { usage: { elapsedMs: index } },
                { inputsHash: `input:${index}` },
              ][worker]!,
            ),
          );
          break;
        case 'job-terminal':
          results.push(
            jobs.update('job-1', { state: worker % 2 === 0 ? 'completed' : 'cancelled' }),
          );
          break;
        case 'hold':
          journal.transact({
            journalId: JOURNAL,
            execute: (prior) => {
              prior[0]!.detail.note = 'uncommitted mutation';
              send('held');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
              return { events: [event('never-committed')], result: null };
            },
          });
          break;
        case 'commit-and-die':
          journal.append({ events: [event('acknowledged')] });
          send('held');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          break;
        default:
          throw new Error(`unknown fixture action ${String(action)}`);
      }
    }
    send({ results }, true);
  } catch (error) {
    send({ error: { code: (error as { code?: string }).code, message: String(error) } }, true);
  }
});
send('ready');

/** A real store lock, held until the parent has terminated the calculation worker. */
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { withFileLock } from '../../../workflows/src/local/file-lock.js';

const { directory, release } = workerData as { directory: string; release: SharedArrayBuffer };
const signal = new Int32Array(release);
withFileLock(join(directory, '.locks', 'artifact-index'), () => {
  parentPort?.postMessage('locked');
  while (Atomics.load(signal, 0) === 0) Atomics.wait(signal, 0, 0);
});
parentPort?.close();

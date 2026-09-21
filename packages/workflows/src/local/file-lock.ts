/// <reference types="node" />
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { ErrorCode, InputError } from '@totalfinance/core';

const pause = new Int32Array(new SharedArrayBuffer(4));
const active = new Set<string>();
const roots = new Set<string>();
const WAIT_MS = 5_000;
let watchingWorkers = false;

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM is not proof of death. Never steal a live or unverifiable owner's lock.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Sync new directory entries too: syncing a document alone cannot persist its new ancestors. */
export function ensureDirectory(path: string): void {
  const created = mkdirSync(path, { recursive: true });
  if (created === undefined) return;
  const stop = dirname(created);
  for (let directory = path; ; directory = dirname(directory)) {
    syncDirectory(directory);
    if (directory === stop) break;
  }
}

/**
 * The local job runner creates stores before spawning workers. Observe those workers in their
 * host: forced termination skips worker finally/exit handlers while the host PID remains alive.
 * Only a confirmed exit permits clearing that (PID, threadId)'s unique registers. Other hosts
 * continue to recover whole-process death through kill(pid, 0); no age-based lock stealing.
 */
export function trackFileLockRoot(directory: string): void {
  ensureDirectory(directory);
  roots.add(realpathSync(directory));
  if (watchingWorkers) return;
  watchingWorkers = true;
  process.on('worker', (worker) => {
    const prefix = `${process.pid}-${worker.threadId}-`;
    worker.once('exit', () => {
      const clean = (path: string): void => {
        try {
          for (const entry of readdirSync(path, { withFileTypes: true })) {
            const child = join(path, entry.name);
            if (entry.isDirectory()) clean(child);
            else if (entry.isFile() && entry.name.startsWith(prefix)) remove(child);
          }
        } catch (error) {
          if (!missing(error)) throw error;
        }
      };
      for (const root of roots) {
        try {
          clean(root);
        } catch {
          // An inaccessible register remains fail-closed. Cleanup must not crash the host.
          process.emitWarning("FileStore: could not clear an exited worker's lock records.", {
            code: ErrorCode.OperationInternal,
          });
        }
      }
    });
  });
}

/** Durable replacement: sync the complete document, rename, then sync the containing directory. */
export function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    remove(temp);
  }
}

/**
 * A local-filesystem Lamport bakery lock. Every contender owns a unique, immutable pathname;
 * first announce "choosing", then publish (ticket, token) and wait for all earlier contenders.
 * Atomic renames make each register read complete. Dead owners' registers can be removed safely:
 * unlike unlinking/replacing one shared lockfile, reclamation cannot delete a new owner's lock.
 *
 * Synchronous, bounded waits; a live owner is NEVER expired by age. Crash-left temp files are not
 * registers and are ignored. PID reuse fails closed (a bounded timeout), not mutual-exclusion loss.
 * Requires one host with coherent local filesystem semantics, not a distributed/network lock.
 */
export function withFileLock<T>(directory: string, execute: () => T): T {
  ensureDirectory(directory);
  const root = realpathSync(directory);
  if (active.has(root)) {
    throw new InputError('FileStore: nested writes to the same locked resource are not allowed.', {
      code: ErrorCode.InputWrongShape,
      context: { function: 'FileStore.lock', field: 'directory' },
    });
  }
  active.add(root);
  const token = `${process.pid}-${threadId}-${randomUUID()}`;
  const path = join(root, `${token}.json`);
  const deadline = performance.now() + WAIT_MS;
  const wait = (): void => {
    if (performance.now() >= deadline) {
      throw new InputError(`FileStore: timed out after ${WAIT_MS}ms waiting for another writer.`, {
        code: ErrorCode.OperationDeadlineExceeded,
        context: { function: 'FileStore.lock', field: 'directory' },
      });
    }
    Atomics.wait(pause, 0, 0, 5);
  };
  const read = (name: string): bigint | null | undefined => {
    const pid = Number(name.slice(0, name.indexOf('-')));
    if (dead(pid)) {
      remove(join(root, name));
      return undefined;
    }
    try {
      const ticket = JSON.parse(readFileSync(join(root, name), 'utf8')) as string | null;
      return ticket === null ? null : BigInt(ticket);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  };
  const contenders = (): string[] =>
    readdirSync(root).filter((name) => /^\d+-\d+-[a-f0-9-]+\.json$/.test(name));
  try {
    writeAtomic(path, 'null');
    let ticket = 1n;
    for (const name of contenders()) {
      const other = read(name);
      if (other !== undefined && other !== null && other >= ticket) ticket = other + 1n;
    }
    writeAtomic(path, JSON.stringify(String(ticket)));
    for (const name of contenders()) {
      if (name === `${token}.json`) continue;
      for (;;) {
        const other = read(name);
        if (
          other === undefined ||
          (other !== null && (other > ticket || (other === ticket && name > `${token}.json`)))
        )
          break;
        wait();
      }
    }
    return execute();
  } finally {
    try {
      remove(path);
    } finally {
      active.delete(root);
    }
  }
}

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Stage 4.7 (FC9, Decision 7) — no compute package fetches data, reads credentials, uses the
 * process clock, or performs an external side effect. The core-freeze gate states it; this scan
 * makes it executable: every `src` file of every compute package is searched for the process clock,
 * the environment, the network, the filesystem / child processes / worker threads, and unseeded
 * randomness, and every hit must sit on the frozen allowlist below with its reason.
 *
 * The transports (`cli`, `http`, `mcp`) are not compute packages and are not scanned. The
 * `@totalfinance/workflows` registry is scanned except for its declared local layer (`src/local/*`:
 * file stores, jobs, the job worker — the one place the library touches a disk and a wall clock,
 * by contract, behind an explicit import).
 *
 * The allowlist is SHRINK-ONLY: a new hit fails here; an allowlisted route with no hit left fails
 * too, so the list stays exact.
 */

const PACKAGES = fileURLToPath(new URL('../packages', import.meta.url));

/** Packages that are transports, not compute — they may read a clock, a socket, and a disk. */
const TRANSPORTS = new Set(['cli', 'http', 'mcp']);

const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['clock', /\bDate\.now\(|\bnew Date\(\)|\bperformance\.now\(|\bprocess\.hrtime\b/],
  ['environment', /\bprocess\.env\b|\bprocess\.argv\b|\bprocess\.cwd\(/],
  ['network', /\bfetch\(|\bXMLHttpRequest\b|\bnode:https?\b|\bnode:net\b|\bWebSocket\b/],
  [
    'filesystem/process',
    /\bnode:fs\b|\bnode:child_process\b|\bnode:worker_threads\b|\bimport\.meta\.url\b/,
  ],
  ['randomness', /\bMath\.random\(|\bcrypto\.randomUUID\(/],
];

/**
 * Every permitted hit: `<package-relative path>` → the pattern classes it may carry, with the reason.
 * A directory entry (trailing `/`) covers every file beneath it.
 */
const ALLOWED: ReadonlyArray<{ route: string; classes: readonly string[]; reason: string }> = [
  {
    route: 'workflows/src/stores-trade.ts',
    classes: ['randomness'],
    reason:
      'A memory journal store receives an opaque storage identity once at explicit construction, to bind single-use authorization to the same store. It never affects computed financial values, plan hashes, receipts or transport results. File-store identities are durable in the declared local layer.',
  },
  {
    route: 'workflows/src/local/',
    classes: ['clock', 'filesystem/process'],
    reason:
      'The declared local layer (Stage 7A Decision 5): file-backed stores, the job runner, and the worker thread are the one place the library touches a disk and a wall clock, behind an explicit `@totalfinance/workflows/local` import; the elapsed-time usage figures they report are labelled as measurements.',
  },
  {
    route: 'workflows/src/runtime.ts',
    classes: ['clock'],
    reason:
      "The runtime's deadline clock is injectable (`options.now`); the default reads the wall clock for the DEADLINE verdict of an operation run, never for a computed value — every operation result is clock-free by the registry contract.",
  },
];

interface Hit {
  route: string;
  line: number;
  class: string;
  text: string;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  const walk = (dir: string, pkg: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, pkg);
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        const lines = readFileSync(p, 'utf8').split('\n');
        lines.forEach((raw, index) => {
          const line = raw.trim();
          if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;
          for (const [cls, pattern] of PATTERNS) {
            if (pattern.test(raw)) {
              hits.push({
                route: relative(PACKAGES, p),
                line: index + 1,
                class: cls,
                text: line.slice(0, 120),
              });
            }
          }
        });
      }
    }
  };
  for (const pkg of readdirSync(PACKAGES).sort()) {
    if (TRANSPORTS.has(pkg)) continue;
    const src = join(PACKAGES, pkg, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src, pkg);
    } catch {
      // a package without src — nothing to scan
    }
  }
  return hits;
}

const permitted = (hit: Hit): boolean =>
  ALLOWED.some(
    (entry) =>
      (entry.route.endsWith('/') ? hit.route.startsWith(entry.route) : hit.route === entry.route) &&
      entry.classes.includes(hit.class),
  );

describe('no compute package reads a clock, the environment, the network, or the filesystem (FC9 Decision 7)', () => {
  const hits = scan();

  it('scans the compute packages (not vacuous)', () => {
    expect(readdirSync(PACKAGES).filter((p) => !TRANSPORTS.has(p)).length).toBeGreaterThan(15);
  });

  it('every clock / environment / network / filesystem / randomness reference is on the allowlist with a reason', () => {
    const offenders = hits
      .filter((hit) => !permitted(hit))
      .map((hit) => `${hit.class} ${hit.route}:${hit.line} — ${hit.text}`);
    expect(offenders).toEqual([]);
  });

  it('the allowlist only shrinks — every entry still has a hit of each class it permits', () => {
    const stale: string[] = [];
    for (const entry of ALLOWED) {
      for (const cls of entry.classes) {
        const live = hits.some(
          (hit) =>
            hit.class === cls &&
            (entry.route.endsWith('/')
              ? hit.route.startsWith(entry.route)
              : hit.route === entry.route),
        );
        if (!live) stale.push(`${entry.route} [${cls}]`);
      }
      expect(entry.reason.length, `${entry.route} carries a reason`).toBeGreaterThan(40);
    }
    expect(stale).toEqual([]);
  });

  it('unseeded randomness is limited to the opaque store identity, never financial computation', () => {
    expect(hits.filter((hit) => hit.class === 'randomness')).toEqual([
      expect.objectContaining({
        route: 'workflows/src/stores-trade.ts',
        text: 'const identity = globalThis.crypto.randomUUID();',
      }),
    ]);
  });

  it('no compute package reaches the network', () => {
    expect(hits.filter((hit) => hit.class === 'network')).toEqual([]);
  });
});

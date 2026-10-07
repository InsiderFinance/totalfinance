#!/usr/bin/env node
/**
 * Captures what the PUBLISHED `@insiderfinance/totalfinance@0.1.2` returns from `optionFlowDrift`
 * for the shared cases in `packages/structure/test/golden/option-flow-drift-cases.mjs`, so the drift
 * premium path is checked against the released artifact rather than against the code it rewrote.
 *
 * Reproduce (the output must not change — it pins a released version):
 *
 *     npm install --prefix /tmp/tf012 @insiderfinance/totalfinance@0.1.2
 *     node tools/golden/capture-option-flow-drift-baseline.mjs /tmp/tf012/node_modules/@insiderfinance/totalfinance
 *
 * Output (committed, so CI needs no network): packages/structure/test/golden/option-flow-drift-0.1.2.json,
 * one SHA-256 per case over the full result (or the error's name, code and message). Drift is sums
 * and products of the supplied numbers, with no transcendental functions, so one file holds for
 * every platform.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL, pathToFileURL } from 'node:url';
import console from 'node:console';
import process from 'node:process';
import {
  optionFlowDriftCases,
  optionFlowDriftOutcome,
} from '../../packages/structure/test/golden/option-flow-drift-cases.mjs';

const root = process.argv[2];
if (!root) {
  console.error(
    'usage: capture-option-flow-drift-baseline.mjs <installed @insiderfinance/totalfinance root>',
  );
  process.exit(2);
}
const load = (path) => import(pathToFileURL(join(root, 'modules', path)).href);
const { optionFlowDrift } = await load('structure/dist/index.js');
const { resolvedExpiry } = await load('core/dist/index.js');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const digests = {};
for (const { name, input } of optionFlowDriftCases(resolvedExpiry)) {
  digests[name] = createHash('sha256')
    .update(optionFlowDriftOutcome(optionFlowDrift, input))
    .digest('hex');
}
const out = new URL(
  '../../packages/structure/test/golden/option-flow-drift-0.1.2.json',
  import.meta.url,
);
writeFileSync(
  out,
  `${JSON.stringify({ meta: { package: `@insiderfinance/totalfinance@${version}`, cases: Object.keys(digests).length }, digests }, null, 2)}\n`,
);
console.log(`wrote ${Object.keys(digests).length} digests from ${version}`);

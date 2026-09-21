/**
 * Produce ONE enforcement record in a FRESH PROCESS, and report a digest of it.
 *
 * The conformance gates need to compare a freshly generated record against the committed one, and to
 * compare two independent generations against each other. Doing that inside the test worker cost a
 * hosted CI run 44–52 minutes and an 8 GB heap: each generation imports the whole library, resolves
 * ~4,000 callables and constructs receivers, with istanbul instrumenting every line of it, and the
 * worker held two at once.
 *
 * Running them out of process fixes three things at once, which is why it is the right shape rather
 * than merely the cheap one:
 *
 *   COST        The coverage-instrumented worker performs no generation at all. It reads a file.
 *   ISOLATION   Two generations no longer share a module realm, so the second cannot inherit state the
 *               first left behind — which is exactly the confound that makes `stoch` and `stochastic`
 *               disagree despite being one function with one contract.
 *   HONESTY     A digest over the FULL record, not just `[id, verdict]`. Comparing verdicts alone
 *               would call two runs identical while their evidence differed, and evidence is the part
 *               a reader acts on.
 *
 * Usage: `tsx tools/manifest/enforcement-run.ts [outputPath]`. Prints the digest on stdout; writes the
 * full record to `outputPath` when given.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { buildEnforcementRecord } from './contract-enforcement.js';

const record = await buildEnforcementRecord();
const serialized = JSON.stringify(record);

const outputPath = process.argv[2];
if (outputPath !== undefined) writeFileSync(outputPath, serialized);

/**
 * The digest covers the whole record, `summary` included. Two runs that agree on every verdict and
 * disagree on a count have disagreed, and a gate that cannot see that is not checking determinism.
 */
process.stdout.write(createHash('sha256').update(serialized).digest('hex'));

/**
 * Refresh every gated figure in the closeout spec from the enforcement artifact.
 *
 * Hand-editing these has cost three CI failures in two rounds, twice to the SAME defect: a `[\d,]+`
 * pattern is greedy across the comma that SEPARATES two buckets, so `input.out_of_range` 49,
 * `input.missing_field` 8 loses its separator and the header gate reports a null. The number pattern
 * here is a thousands separator only — digits, then groups of exactly three — which cannot span a
 * list comma.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const NUM = String.raw`\d{1,3}(?:,\d{3})*`;
const summary = JSON.parse(readFileSync('tools/manifest/public-enforcement.json', 'utf8')).summary;
const spec = 'docs/specs/phase-3b-runtime-semantic-closeout.md';
const n = (value) => value.toLocaleString('en-US');
let text = readFileSync(spec, 'utf8');
/**
 * Substitute, and FAIL if nothing matched.
 *
 * A silent no-op is the worst outcome for a refresher: it reports success while leaving a stale
 * figure in a gated document, so the gate fails later and the script's own green run is the reason
 * nobody looked here. Every substitution is required to hit at least once.
 */
const missed = [];
const sub = (pattern, replacement, { required = true } = {}) => {
  const expression = new RegExp(pattern, 'gm');
  if (!expression.test(text)) {
    if (required) missed.push(pattern);
    return;
  }
  text = text.replace(new RegExp(pattern, 'gm'), replacement);
};

sub(
  String.raw`\*\*enforced ${NUM} · partial ${NUM} · defective ${NUM} · unmeasured ${NUM}\*\*`,
  `**enforced ${n(summary.enforced)} · partial ${n(summary.partial)} · defective ${n(summary.defective)} · unmeasured ${n(summary.unmeasured)}**`,
);
for (const [reason, count] of Object.entries(summary.unmeasuredByReason)) {
  sub(String.raw`(\`${reason}\` )${NUM}`, `$1${n(count)}`);
}
for (const code of ['input.out_of_range', 'input.missing_field', 'input.wrong_type']) {
  sub(
    String.raw`(\`${code.replace('.', String.raw`\.`)}\` )${NUM}`,
    `$1${n(summary.rejectionsByCode[code])}`,
  );
}
sub(
  String.raw`(\*\*)${NUM}( defective declaration templates\*\*)`,
  `$1${n(summary.defectiveDeclarationTemplates)}$2`,
);
sub(
  String.raw`(\*\*)${NUM}( defective measurement targets\*\*)`,
  `$1${n(summary.defectiveMeasurementTargets)}$2`,
);
sub(
  String.raw`(\`unknown-key\` ran )${NUM}( times and is attributed to )${NUM}`,
  `$1${n(summary.mutationsExecuted['unknown-key'])}$2${n(summary.mutationsCovered['unknown-key'])}`,
);
sub(
  String.raw`(split the same way \()${NUM}( direct, )${NUM}`,
  `$1${n(summary.failuresDirect)}$2${n(summary.failuresAttributed)}`,
);
sub(
  String.raw`(\`non-finite\` 3,357 -> )${NUM}`,
  `$1${n(summary.mutationsExecuted['non-finite'])}`,
);

/**
 * Table rows carry NUMBERS ONLY — column padding is prettier's job, not this script's.
 *
 * Emitting hand-padded columns made the script non-idempotent against a formatted document: running
 * it on a clean head rewrote whitespace, `format:check` then failed, and the fix looked like a
 * formatting problem rather than a tooling one. Writing the minimal row and letting the formatter
 * align it means a run on an unchanged artifact is a no-op, which is what "refresh" should mean.
 */
text = text.replace(
  new RegExp(String.raw`^\|\s*\`([a-z-]+)\`\s*\|\s*${NUM}\s*\|\s*${NUM}\s*\|$`, 'gm'),
  (row, mutation) => {
    const executed = summary.mutationsExecuted[mutation];
    if (executed === undefined) return row;
    /**
     * A row whose numbers are already right is returned BYTE-IDENTICAL.
     *
     * Rewriting it unconditionally is what made the script non-idempotent: the formatter pads these
     * columns, the script re-emitted them unpadded, and a run on a clean head produced a whitespace
     * diff that `format:check` then failed on. "Refresh" has to mean no-op when nothing moved.
     */
    const current = row.match(/\d[\d,]*/g) ?? [];
    const wanted = [n(executed), n(summary.mutationsCovered[mutation])];
    if (current.length === 2 && current[0] === wanted[0] && current[1] === wanted[1]) return row;
    return `| \`${mutation}\` | ${wanted[0]} | ${wanted[1]} |`;
  },
);
/**
 * THE LIVE HEADER'S ALTERNATIVE-LEVEL `branch-not-realized` FIGURE.
 *
 * It was hand-maintained and drifted the moment the generalized branch node changed what is
 * reachable — the header said 27 while the artifact recorded 30, and the header gate caught it,
 * which is the gate working and the refresher not owning its subject. Anything a gate checks should
 * be generated, or the next round pays the same tax.
 *
 * SCOPED TO THE HEADER, by matching only the phrasing the header uses ("carry it, N alternatives
 * do"). The dated round entries below it state the same kind of figure for the artifact AS IT WAS,
 * and those are records rather than figures: refreshing one rewrites history to match the present
 * and destroys the evidence a round was judged on. A first attempt at this substituted across the
 * whole document and did exactly that.
 */
const notRealized = (summary.alternativeUnmeasuredByReason ?? {})['branch-not-realized'];
if (notRealized !== undefined) {
  sub(String.raw`(carry it, )${NUM}( alternatives do)`, `$1${n(notRealized)}$2`);
}

writeFileSync(spec, text);
if (missed.length > 0) {
  process.stderr.write(
    `refresh-spec-figures: ${missed.length} substitution(s) matched nothing — the spec no longer ` +
      `says what this script expects, so a figure it should own may be stale:\n` +
      missed.map((pattern) => `  ${pattern}\n`).join(''),
  );
  process.exitCode = 1;
}
process.stdout.write('spec figures refreshed from the artifact\n');

import { checkReports, writeReports } from './generate.js';

const mode = process.argv.includes('--write')
  ? 'write'
  : process.argv.includes('--check')
    ? 'check'
    : 'check';

if (mode === 'write') {
  const written = writeReports();
  if (written.length === 0) {
    console.log('api-report: no packages with source entrypoints found.');
  } else {
    console.log(`api-report: wrote ${written.map((p) => `@totalfinance/${p}`).join(', ')}`);
  }
  process.exit(0);
}

const results = checkReports();
let failed = false;
for (const r of results) {
  switch (r.status) {
    case 'ok':
      console.log(`✓ @totalfinance/${r.pkg} API report up to date`);
      break;
    case 'skipped':
      console.log(`· @totalfinance/${r.pkg} skipped (no source entrypoint yet)`);
      break;
    case 'missing-snapshot':
      failed = true;
      console.error(
        `✗ @totalfinance/${r.pkg} has no committed API report. Run \`pnpm api:update\`.`,
      );
      break;
    case 'drift':
      failed = true;
      console.error(
        `✗ @totalfinance/${r.pkg} API report is stale. Run \`pnpm api:update\` and review.`,
      );
      break;
  }
}

process.exit(failed ? 1 : 0);

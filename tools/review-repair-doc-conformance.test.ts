/** Keep the September repair contracts visible at the places a fresh implementer starts. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../docs/${path}`, import.meta.url), 'utf8');
const normalized = (text: string): string => text.replace(/\s+/g, ' ');

describe('September repair documentation consistency', () => {
  it('orders pre-open facts, prior decisions, close-derived lifecycle and next decisions causally', () => {
    const spec = read('specs/portfolio-scale-backtesting.md');
    const sessions = normalized(spec.slice(spec.indexOf('**6b —'), spec.indexOf('**6c —')));
    expect(sessions).toMatch(
      /Pre-open facts.*Previously queued orders.*Post-open lifecycle and valuation.*Next decision/,
    );
    expect(sessions).toContain('close-derived');
    expect(sessions).toContain('cannot finance');
    expect(sessions).toContain('exactly one observation of delay');
    expect(sessions).toContain('no new strategy decision');
    expect(sessions).not.toContain('strategy → orders → execution');
  });

  it('distinguishes the pure grant representation from trusted workflow approval', () => {
    const guide = normalized(read('guides/trade-lifecycle.md'));
    expect(guide).toContain('A hash is integrity, not approval authority');
    expect(guide).toContain('same authorization store');
    expect(guide).toContain('const grant = createAuthorizationGrant({');
    expect(guide).toContain('grantHash: grant.contentHash');
    expect(guide).toContain('Workflow submission requires an unchanged approved grant');
    expect(guide).toContain('Cancellation uses the persisted order context and has no grant input');
    expect(guide).not.toContain('Workflow submit/cancel requires an unchanged approved grant');
    expect(guide).toContain('Idempotency belongs to a journal and its authoritative store');
    // Pre-publish repairs B6 supersede R10's "no global consumption": a grant is consumed by its
    // prepared submission, before commit, and only that submission's retry recovers its facts.
    expect(guide).toContain('A grant licenses one durably prepared submission');
    expect(guide).toContain(
      'every submit or cancel into the original journal recovers all its pending batches',
    );
    expect(guide).toContain('stable, non-empty `storeId`');
    expect(guide).toContain('persist its exact `journalEvents` before returning');
    expect(guide).toContain('trade.grant_consumed');
    expect(guide).not.toContain('Different source IDs or stores are independent paper simulations');
    expect(guide).toContain('--profile full --input authorize.json --capability trade:approve');
    expect(guide).toContain('--profile full --input submit.json --capability trade:paper');
  });

  it('teaches the HTTP credential separately from capabilities and approved grants', () => {
    const guide = normalized(read('guides/trade-lifecycle.md'));
    for (const name of [
      'authenticationToken',
      '--token-file',
      'TOTALFINANCE_HTTP_TOKEN',
      'Authorization: Bearer <token>',
      'Content-Type: application/json',
      'Job creation/cancellation',
    ]) {
      expect(guide).toContain(name);
    }
    expect(guide).toContain('A token does not grant capabilities or replace stored approval');
    expect(guide).toContain('unauthenticated inline read-only analytics remain available');
  });

  it('documents resumable orders and safe migration as supported, not deferred', () => {
    const guide = read('guides/trade-lifecycle.md');
    const supported = normalized(guide.split('## What is deferred, and why')[0]!);
    const deferred = normalized(guide.split('## What is deferred, and why')[1]!);
    expect(supported).toContain('Continuing a paper order and upgrading stores');
    expect(supported).toContain('exact snapshot assertion');
    expect(supported).toContain('stop all old-version writers');
    expect(supported).toContain('journals/v2/<sha256-of-exact-id>.json');
    expect(supported).toContain('Incomplete legacy paper-order context refuses restoration');
    expect(supported).toContain('corruption is not treated as an empty journal');
    expect(deferred).not.toContain('A broker that steps across calls');
  });

  it('recovers lost committed responses using cumulative receipt events and ledger idempotence', () => {
    const guide = normalized(read('guides/trade-lifecycle.md'));
    expect(guide).toContain('events: submitted.recovery.events');
    expect(guide).toContain('fills: submitted.recovery.fills');
    expect(guide).toContain('Top-level `fills`/`events` are current-call deltas');
    expect(guide).toContain(
      'Reapplying an identical event ID and body is idempotent in the ledger',
    );
    expect(guide).toContain('Capability and trusted-store approval checks still apply');
    expect(guide).toContain('Receipt recovery remains possible after grant expiry');
    expect(guide).toContain('Expiry does not cancel already-accepted orders');
    expect(guide).not.toContain('The grant must still be valid');
    const spec = normalized(read('specs/trade-lifecycle-and-paper-execution.md'));
    expect(spec).toContain('`receipt` remains immutable');
    expect(spec).toContain('`recovery: { fills, events }`');
  });

  it('requires the transaction method at the normative custom-store contract', () => {
    const spec = normalized(read('specs/trade-lifecycle-and-paper-execution.md'));
    expect(spec).toContain('`transact({ journalId, execute })`');
    expect(spec).toContain('`transact` is mandatory');
    expect(spec).toContain('returns the result only after commit; exceptions commit nothing');
    expect(spec).toContain('September correctness addendum');
  });

  it('marks Stage 7A complete and supersedes its original no-auth restrictions', () => {
    const spec = normalized(read('specs/local-operations-and-transports.md'));
    expect(spec).toContain('**Status:** `COMPLETE @ c7bdb260d`');
    expect(spec).toContain('Current amendments');
    expect(spec).toContain('authenticationToken');
    expect(spec).toContain('Current handoff');
    expect(spec).not.toContain('has no auth on purpose');
    expect(spec).not.toContain('still unauthenticated and read-only');
    expect(spec).not.toContain('Stage 7A is the active row');
  });

  it('keeps locally completed repairs distinct from maintainer-held publication', () => {
    const order = normalized(read('implementation-order.md'));
    const finance = normalized(read('specs/finance-portfolio-backtesting-completeness.md'));
    for (const text of [order, finance]) {
      expect(text).toContain('review-september-2026-repairs.md');
      expect(text).toContain('MAINTAINER-HELD; LOCAL REPAIRS COMPLETE');
      expect(text).toContain('locally verified complete');
      expect(text).not.toMatch(/Stage 5A[^\n]*?shipping \((?:`)?CURRENT/);
      expect(text).not.toContain('Stage 5A is now the active row');
    }
    expect(order).not.toContain('Stage 4 is now ACTIVE');
    expect(order).not.toContain('Preview lane — **ACTIVE**');
    const previewRow = read('specs/finance-portfolio-backtesting-completeness.md')
      .split('\n')
      .find((line) => /^\| Stage 5A\s*\|/.test(line));
    expect(previewRow).toBeDefined();
    expect(previewRow).not.toContain('CURRENT');
  });

  it('closes the owned repair handoffs without granting release authority or rewriting history', () => {
    const index = normalized(read('README.md'));
    const platform = normalized(read('agent-native-portfolio-and-trading-platform.md'));
    for (const text of [index, platform]) {
      expect(text).toContain('review-september-2026-repairs.md');
      expect(text).toContain('Stage 7B.1');
      expect(text).toContain('Stage 7B.2');
      expect(text).toContain('maintainer-held');
    }
    expect(index).not.toContain('is current under its drafted contract');
    expect(platform).not.toContain('Stage 4.5 closes next');
    expect(platform).not.toContain('Stage 7A preview slice queued');
    for (const path of [
      'implementation-order.md',
      'specs/finance-portfolio-backtesting-completeness.md',
      'README.md',
      'agent-native-portfolio-and-trading-platform.md',
      'specs/local-operations-and-transports.md',
      'specs/portfolio-scale-backtesting.md',
      'specs/trade-lifecycle-and-paper-execution.md',
      'library-alignment-spec.md',
    ]) {
      const text = normalized(read(path)).toLowerCase();
      expect(text, path).toContain('locally verified complete');
      expect(text, path).toContain('maintainer-held');
      expect(text, path).toContain('dccfce53');
      expect(text, path).toContain('repair changes');
      for (const stale of [
        'review repairs first',
        'review-repair gate is current',
        'review-repair gate above is current',
        'repair gate must now close',
        'still pending in the repair gate',
        'review corrections are in progress',
        'finish any unchecked review-repair gates',
        'current release-blocking correction gate',
        'not a claim that those checks are complete',
      ]) {
        expect(text, path).not.toContain(stale);
      }
    }
  });

  it('binds the alignment closeout live totals and package breakdown to generated artifacts', () => {
    const artifact = <T>(name: string): T =>
      JSON.parse(readFileSync(new URL(`./manifest/${name}.json`, import.meta.url), 'utf8')) as T;
    const contracts = artifact<{ summary: Record<string, number> }>('public-contracts').summary;
    const naming = artifact<{ summary: { identities: number } }>('public-naming').summary;
    const enforcement = artifact<{
      summary: Record<string, number>;
      enforcement: {
        package: string;
        verdict: 'enforced' | 'partial' | 'defective' | 'unmeasured';
      }[];
    }>('public-enforcement');
    const text = normalized(read('library-alignment-spec.md'));
    const format = (value: number): string => value.toLocaleString('en-US');
    for (const [key, label] of [
      ['publicPaths', 'public paths'],
      ['implementations', 'implementations'],
      ['inputContracts', 'input contracts'],
      ['resultContracts', 'result contracts'],
      ['validatorIdentities', 'validator identities'],
    ]) {
      expect(text).toContain(`${format(contracts[key!]!)} ${label}`);
    }
    expect(text).toContain(
      `unnameable parameter contracts ${contracts['unnameableParameterContracts']}`,
    );
    expect(text).toContain(`naming identities ${format(naming.identities)} with 0 unresolved`);
    for (const label of ['enforced', 'partial', 'defective', 'unmeasured']) {
      expect(text).toContain(`${format(enforcement.summary[label]!)} ${label}`);
    }
    expect(text).toContain(`of ${format(enforcement.summary['candidates']!)} measured candidates`);

    const packages = new Set(enforcement.enforcement.map((row) => row.package));
    for (const name of packages) {
      const rows = enforcement.enforcement.filter((row) => row.package === name);
      const counts = [
        rows.length,
        rows.filter((row) => row.verdict === 'enforced').length,
        rows.filter((row) => row.verdict === 'partial').length,
        rows.filter((row) => row.verdict === 'unmeasured').length,
      ];
      const label =
        name === 'totalfinance'
          ? 'umbrella'
          : name === '@totalfinance/mcp'
            ? 'MCP'
            : name.replace('@totalfinance/', '');
      expect(text).toContain(`${label} ${counts.map(format).join('·')}`);
    }
  });
});

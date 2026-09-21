import { describe, expect, it } from 'vitest';
import { generateInternalSignatureInventory } from './internal-signature-inventory.js';
import { INTERNAL_SIGNATURE_POLICIES } from './internal-signature-policy.js';

describe('internal financial signature conformance (Phase 3A)', () => {
  it('contains no unreviewed long numeric request vectors', () => {
    const candidates = generateInternalSignatureInventory();
    const unreviewed = candidates.filter(
      (candidate) => INTERNAL_SIGNATURE_POLICIES[candidate.id] === undefined,
    );
    expect(
      unreviewed,
      unreviewed.map((candidate) => `${candidate.id}: ${candidate.signature}`).join('\n'),
    ).toEqual([]);
  }, 60_000);

  it('contains no stale internal exception', () => {
    const live = new Set(generateInternalSignatureInventory().map((candidate) => candidate.id));
    const stale = Object.keys(INTERNAL_SIGNATURE_POLICIES).filter((id) => !live.has(id));
    expect(stale, `stale internal signature policies:\n${stale.join('\n')}`).toEqual([]);
  }, 60_000);

  it('keeps every exception documented with a substantive rationale', () => {
    const weak = Object.entries(INTERNAL_SIGNATURE_POLICIES)
      .filter(([, rationale]) => rationale.trim().length < 40)
      .map(([id]) => id);
    expect(weak, `weak internal signature rationales:\n${weak.join('\n')}`).toEqual([]);
  });
});

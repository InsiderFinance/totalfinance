import { describe, expect, it } from 'vitest';
import { changelogExcerpt } from './changelog-excerpt.js';

const CHANGELOG = `# totalfinance

## 0.1.0-preview.1

### Minor Changes

- abc1234: The second preview.

## 0.1.0-preview.0

### Minor Changes

- def5678: The first public preview of TotalFinance.

### Patch Changes

- Updated dependencies [def5678]
  - @totalfinance/core@0.1.0-preview.0
`;

describe('changelog excerpt — the release notes come from what changesets wrote, not from prose typed at release time', () => {
  it('returns exactly one version section, trimmed, with a trailing newline', () => {
    expect(changelogExcerpt(CHANGELOG, '0.1.0-preview.0')).toBe(
      '### Minor Changes\n\n- def5678: The first public preview of TotalFinance.\n\n### Patch Changes\n\n- Updated dependencies [def5678]\n  - @totalfinance/core@0.1.0-preview.0\n',
    );
  });

  it('the newest section ends at the next version heading, not at the end of the file', () => {
    expect(changelogExcerpt(CHANGELOG, '0.1.0-preview.1')).toBe(
      '### Minor Changes\n\n- abc1234: The second preview.\n',
    );
  });

  it('a version that was never written is undefined, so the workflow refuses rather than shipping empty notes', () => {
    expect(changelogExcerpt(CHANGELOG, '0.1.0-preview.2')).toBeUndefined();
    expect(changelogExcerpt(CHANGELOG, '0.1.0-preview')).toBeUndefined();
  });
});

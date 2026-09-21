/** Phase 3A / Law 14: public argument shape is an executable API contract. */

import { describe, expect, it } from 'vitest';
import {
  generatePublicSignatureManifest,
  readPublicSignatureManifest,
  type PublicCallable,
  type SignatureParameter,
} from './signature-inventory.js';
import { SIGNATURE_POLICIES } from './signature-policy.js';

const HIGH_LEVEL_ROLES = new Set(['facade', 'analysis', 'artifact']);
const FINANCIAL_PACKAGES = new Set([
  '@totalfinance/backtest',
  '@totalfinance/crypto',
  '@totalfinance/fixed-income',
  '@totalfinance/options',
  '@totalfinance/performance',
  '@totalfinance/risk',
  '@totalfinance/scenarios',
  '@totalfinance/strategy',
  '@totalfinance/structure',
  '@totalfinance/technical-analysis',
  '@totalfinance/volatility',
]);

function signatureLabel(callable: PublicCallable, parameters: SignatureParameter[]): string {
  return `${callable.id}(${parameters
    .map((parameter) => `${parameter.name}${parameter.optional ? '?' : ''}: ${parameter.type}`)
    .join(', ')})`;
}

describe('public signature conformance (Law 14)', () => {
  it('the committed declaration inventory matches the live TypeScript surface exactly', () => {
    const committed = readPublicSignatureManifest();
    expect(
      committed,
      'missing tools/manifest/public-signatures.json — run pnpm signature:update',
    ).toBeTruthy();
    /**
     * THE COMPILER FIRST, for the same reason the contract-conformance gate does it: every `type`
     * string here is `checker.typeToString(...)` output, so a different compiler rewrites the file
     * without the library changing, and a deep-equal failure would bury that in a thousand lines of
     * near-identical type strings.
     */
    const fresh = generatePublicSignatureManifest();
    expect(
      fresh.typescriptVersion,
      `public-signatures.json was generated with TypeScript ${committed?.typescriptVersion} and you ` +
        `are running ${fresh.typescriptVersion}. The dependency is pinned exactly in package.json — ` +
        `reinstall rather than regenerating.`,
    ).toBe(committed?.typescriptVersion);
    expect(committed).toEqual(fresh);
  }, 60_000);

  it('every policy entry names a live public callable', () => {
    const live = new Set(
      generatePublicSignatureManifest().callables.map((callable) => callable.id),
    );
    const stale = Object.keys(SIGNATURE_POLICIES).filter((id) => !live.has(id));
    expect(stale, `stale signature policies:\n${stale.join('\n')}`).toEqual([]);
  }, 60_000);

  it('a numeric parameter is a number, never an object one of whose members names one', () => {
    /**
     * The `numeric` kind has a NAME fallback for branded aliases (`EpochMs`, `Probability`, ...)
     * rendered by name. Read against a member list it misfires: `{ now: EpochMs }` mentions the
     * alias and is an object. Three receiver-method inputs were classified `numeric` this way and
     * the enforcement gate — which only probes object and series arguments — silently dropped
     * `AuthorizationStore#put` from candidacy. A kind is a claim about what a caller passes; an
     * object literal is never a number.
     */
    const offenders = (readPublicSignatureManifest()?.callables ?? []).flatMap((callable) =>
      callable.signatures.flatMap((signature) =>
        signature.parameters
          .filter(
            (parameter) =>
              parameter.kind === 'numeric' &&
              (parameter.type.trimStart().startsWith('{') ||
                (parameter.checkerFieldTree?.length ?? 0) > 0),
          )
          .map((parameter) => `${callable.id}|${parameter.name}: ${parameter.type}`),
      ),
    );
    expect(offenders, 'object-typed parameters classified numeric').toEqual([]);
  });

  it('every callable has one structurally truthful, reviewed grammar', () => {
    const problems: string[] = [];
    const callables = generatePublicSignatureManifest().callables;
    /**
     * A rationale is reviewed once per IMPLEMENTATION, not once per path.
     *
     * The umbrella re-exports ~2,500 scoped callables, and every three-argument positional among them
     * already carries its reviewed rationale under the scoped id in `SIGNATURE_POLICIES`. Demanding a
     * second entry for `totalfinance:adaptiveSimpson` would ask a reviewer to ratify one decision twice and
     * turn the policy file into a list of aliases — this is the alias fan-out rule the scope model
     * states, applied to review effort.
     */
    const rationaleByImplementation = new Set(
      callables.filter((callable) => callable.rationale).map((callable) => callable.implementation),
    );
    for (const callable of callables) {
      if (!callable.rationale && rationaleByImplementation.has(callable.implementation)) continue;
      for (const signature of callable.signatures) {
        const parameters = signature.parameters;
        const label = signatureLabel(callable, parameters);
        const numericCount = parameters.filter((parameter) => parameter.kind === 'numeric').length;

        if (
          callable.grammar === 'object' &&
          !(
            parameters.length === 1 &&
            (parameters[0]!.kind === 'object' || parameters[0]!.kind === 'series')
          )
        ) {
          problems.push(`${label}: grammar "object" requires exactly one object parameter`);
        }
        if (callable.grammar === 'none' && parameters.length !== 0) {
          problems.push(`${label}: grammar "none" requires zero parameters`);
        }
        if (
          callable.grammar === 'columnar' &&
          !parameters.some((parameter) => /Columns(?:<.*>)?$/.test(parameter.type))
        ) {
          problems.push(`${label}: grammar "columnar" requires an object-of-arrays Columns input`);
        }
        if (
          callable.grammar === 'series-options' &&
          !(
            parameters.length === 2 &&
            parameters[0]!.kind === 'series' &&
            parameters[1]!.kind === 'object' &&
            parameters[1]!.optional
          )
        ) {
          problems.push(`${label}: grammar "series-options" requires (series, options?)`);
        }

        if (
          HIGH_LEVEL_ROLES.has(callable.role ?? '') &&
          parameters.length >= 3 &&
          callable.grammar === 'natural-positional'
        ) {
          problems.push(
            `${label}: high-level ${callable.role} operations with three or more arguments use one request object`,
          );
        }
        if (
          callable.owner === 'constructor' &&
          callable.role === 'artifact' &&
          parameters.length >= 2 &&
          callable.grammar === 'natural-positional'
        ) {
          problems.push(
            `${label}: exported artifact constructors with multiple fields use one object`,
          );
        }
        if (
          FINANCIAL_PACKAGES.has(callable.package) &&
          numericCount >= 3 &&
          callable.grammar === 'natural-positional'
        ) {
          problems.push(
            `${label}: financial callables may not expose three or more confusable numeric parameters`,
          );
        }
        if (
          parameters.length >= 3 &&
          callable.grammar === 'natural-positional' &&
          !callable.rationale
        ) {
          problems.push(
            `${label}: retained positional signatures with three or more arguments require a reviewed rationale`,
          );
        }
        if (
          FINANCIAL_PACKAGES.has(callable.package) &&
          numericCount >= 2 &&
          callable.grammar === 'natural-positional' &&
          !callable.rationale
        ) {
          problems.push(
            `${label}: retained financial signatures with two or more numeric coordinates require a reviewed rationale`,
          );
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  }, 60_000);
});

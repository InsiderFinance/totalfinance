/**
 * EVERY UNION THE TYPE TEXT SHOWS MUST APPEAR IN THE ARTIFACT AS ARMS.
 *
 * The defect this exists for is not "an arm was built wrong" — it is "an arm was never recorded", and
 * that failure is invisible from inside the union model. Both the enumeration and the gate that
 * checked it walked `declaredSites`, so a union the walker could not see was absent from both sides
 * and the gate agreed with the generator about a contract neither had read. `number |
 * ArrayLike<number>` was recorded as a bare type name on 78 occurrences across 33 implementations
 * while every check passed.
 *
 * So the two sides here are DIFFERENT DERIVATIONS of the same declaration:
 *
 *   - the artifact's `branches`, produced by walking the checker's union constituents;
 *   - the artifact's `type`, produced by RENDERING that same parameter's type to text.
 *
 * The renderer knows nothing about arms and the arm walk knows nothing about text. If the rendered
 * type offers three top-level alternatives and the arm list has two, one derivation lost something —
 * which is exactly the shape of a silently-dropped grammar, and cannot be hidden by a shared walker.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Node {
  name?: string;
  type?: string;
  kind?: string;
  optional?: boolean;
  branches?: Node[];
  branchTypes?: string[];
  fields?: Node[];
  fieldTree?: Node[];
  element?: Node;
  returns?: Node;
  branchFields?: (Node[] | null)[];
  tuple?: Node[];
}

const artifact = JSON.parse(
  readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
) as { contracts: { id: string; signatures?: { parameters?: Node[] }[] }[] };

/**
 * Split a rendered type on its TOP-LEVEL `|`.
 *
 * Deliberately written here rather than imported: importing the producer's splitter would make this
 * gate agree with the thing it audits, which is the failure it exists to prevent. The cost of a
 * private copy is that its own bugs are invisible — so the arrow rule, quoting and nesting are
 * asserted directly below, because `=>` reading as a closing bracket is a defect this repository has
 * already shipped once.
 */
function topLevelAlternatives(type: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let index = 0; index < type.length; index += 1) {
    const character = type[index]!;
    const previous = index > 0 ? type[index - 1] : undefined;
    if (quote) {
      current += character;
      if (character === quote && previous !== '\\') quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '(' || character === '[' || character === '{' || character === '<')
      depth += 1;
    // `=>` is an arrow, not a closing angle bracket. Missing this drove depth negative and made the
    // rest of a callback type read as top level.
    else if (character === ')' || character === ']' || character === '}') depth -= 1;
    else if (character === '>' && previous !== '=') depth -= 1;
    if (character === '|' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

/** `undefined` and `null` are properties of the SLOT, not alternatives of the shape. */
const meaningful = (parts: string[]): string[] =>
  parts.filter((part) => part !== 'undefined' && part !== 'null');

describe('the splitter this gate depends on', () => {
  it('does not read the `>` of `=>` as a closing bracket', () => {
    expect(topLevelAlternatives('((x: number) => number) | number')).toEqual([
      '((x: number) => number)',
      'number',
    ]);
  });

  it('ignores a `|` nested inside brackets of every kind', () => {
    expect(topLevelAlternatives('Array<A | B>')).toEqual(['Array<A | B>']);
    expect(topLevelAlternatives('{ a: A | B }')).toEqual(['{ a: A | B }']);
    expect(topLevelAlternatives('[A | B, C]')).toEqual(['[A | B, C]']);
  });

  it('ignores a `|` inside a string literal', () => {
    expect(topLevelAlternatives("'a|b' | 'c'")).toEqual(["'a|b'", "'c'"]);
  });

  it('splits a plain union', () => {
    expect(topLevelAlternatives('number | ArrayLike<number>')).toEqual([
      'number',
      'ArrayLike<number>',
    ]);
  });
});

/**
 * Types whose rendered text is a union but whose ARMS are not alternatives of a contract.
 *
 * Each is a case where the two derivations legitimately disagree, and each is named rather than
 * pattern-matched, so a new disagreement has to be looked at instead of absorbed.
 */
const RENDERS_AS_UNION_BUT_IS_NOT = (type: string): boolean =>
  // `boolean` is `true | false` to the checker and one type to a caller.
  type === 'boolean' ||
  // A branded scalar renders as its brand union; the brand is not an alternative.
  /\bbrand\b/i.test(type) ||
  /**
   * A CLOSED LITERAL DOMAIN is recorded as `literals`, not as arms — the same rule the producer
   * applies and the checker-derived gate next door already honours.
   *
   * `calibrationWeights(basis: 'vega' | 'uniform')` renders as two alternatives and records zero
   * arms, correctly: the admitted values are one field, and describing them a second time as arms
   * would double-describe one fact. The measured reason for choosing `literals` is in
   * `semanticArms` — 2,494 literal-domain nodes, one record with 81 admitted values, which as arms
   * would push boundaries past `VARIANT_LIMIT` and truncate real grammar coverage.
   *
   * Two gates disagreeing about what counts as a union is the condition this round exists to remove,
   * so the rule is stated identically in both.
   */
  /**
   * A closed domain of ANY primitive, not just quoted ones.
   *
   * The predicate matched quoted parts only, so `1 | -1` and `1 | 2` read as ordinary unions here
   * while the producer recorded them as neither arms nor a domain. It never fired because no
   * PARAMETER declared one — the sixteen that exist are nested fields — so the two sides disagreed
   * about what a union is and nothing revealed it. A number and a quoted string are both closed
   * admissions; `true`/`false` alone is `boolean`, which the clause above already excludes.
   */
  meaningful(topLevelAlternatives(type)).every(
    (part) => /^(['"`]).*\1$/.test(part) || /^-?\d+(\.\d+)?$/.test(part),
  );

describe('every union in a rendered parameter type is recorded as arms', () => {
  const offenders: string[] = [];
  const checked = { parameters: 0, unions: 0 };

  for (const record of artifact.contracts) {
    for (const signature of record.signatures ?? []) {
      (signature.parameters ?? []).forEach((parameter, index) => {
        checked.parameters += 1;
        const rendered = (parameter.type ?? '').trim();
        if (!rendered || RENDERS_AS_UNION_BUT_IS_NOT(rendered)) return;
        const alternatives = meaningful(topLevelAlternatives(rendered));
        if (alternatives.length <= 1) return;
        checked.unions += 1;
        /**
         * `>=`, NOT `===`, and the difference is a real property rather than slack.
         *
         * The checker flattens through an ALIAS and the renderer does not:
         * `StrategyContext#indicator(field: BarField | ((bar: Bar) => In))` renders two alternatives
         * and resolves to six, because `BarField` is itself five string literals. The artifact is
         * MORE specific than the text there, which is the right direction and not a defect.
         *
         * The direction that matters is the one this gate was written for: fewer arms than the text
         * offers means a grammar went unrecorded, and `0 >= 2` is false, so the 78-occurrence case —
         * a union recorded as a bare type name with no arms at all — still fails here.
         */
        const arms = parameter.branches?.length ?? 0;
        if (arms < alternatives.length) {
          offenders.push(
            `${record.id} arg${index} (${rendered}): text offers ${alternatives.length}, artifact records ${arms}`,
          );
        }
      });
    }
  }

  it('finds unions to check at all — a gate over an empty set proves nothing', () => {
    /**
     * Floors, sitting on MEASURED numbers rather than on round ones: the committed surface renders
     * 88 parameter unions across 4,000+ parameters. The floors are set below that with room for the
     * surface to shrink, and exist only to catch the gate auditing nothing — which is how a check
     * that has quietly stopped selecting its subject reports success.
     */
    expect(checked.parameters, 'the artifact yielded almost no parameters').toBeGreaterThan(1000);
    expect(checked.unions, 'no rendered parameter union was found to audit').toBeGreaterThan(50);
  });

  it('records one arm per rendered alternative, for every public parameter', () => {
    expect(offenders.slice(0, 20), `${offenders.length} parameters disagree`).toEqual([]);
  });
});

/**
 * THE RETIRED REPRESENTATION MUST STAY RETIRED.
 *
 * `branchFields`, `branchTypes` and `branchTuples` described a union's arms three ways, each able to
 * express only the part of an arm that resembled its own shape. They are gone from the artifact, and
 * this is what keeps them gone: a producer that starts emitting one again puts the harness back to
 * having two answers for "what are this union's arms", which is the condition every defect in this
 * round grew out of.
 *
 * The last one found was `selectBranch`, which took `branchFields` as its OWN parameter type — so it
 * kept type-checking against nodes that still carried the arrays and silently answered "no branch"
 * once they were deleted. Ten boundaries quietly lost probe mutations, no verdict moved, and nothing
 * failed. A key-level assertion on the artifact is the check that would have caught it from outside.
 */
describe('the legacy branch arrays are gone from the artifact', () => {
  const RETIRED = ['branchFields', 'branchTypes', 'branchTuples'];

  it('appear nowhere in the published contracts', () => {
    const raw = readFileSync(
      fileURLToPath(new URL('./public-contracts.json', import.meta.url)),
      'utf8',
    );
    const found = RETIRED.filter((key) => raw.includes(`"${key}"`));
    expect(found, `a retired branch array is being emitted again: ${found.join(', ')}`).toEqual([]);
  });

  it('and `branches` is there instead — the gate is not passing by emptiness', () => {
    const raw = readFileSync(
      fileURLToPath(new URL('./public-contracts.json', import.meta.url)),
      'utf8',
    );
    expect(raw.includes('"branches"'), 'no arms are recorded at all').toBe(true);
  });
});

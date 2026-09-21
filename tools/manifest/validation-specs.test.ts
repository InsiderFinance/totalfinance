/**
 * Drift gate for the generated runtime validation specs (spec 3B.1b).
 *
 * The whole point of generating the specs is that the runtime allowlist and the declaration are
 * ONE artifact. That claim is only mechanical if a fresh projection from the inventory equals the
 * committed module byte for byte — otherwise "generated" quietly becomes "was generated once",
 * which is a hand-written list with extra steps.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';
import { generateValidationSpecs } from './validation-specs.js';
import { VALIDATION_ROSTER } from './validation-roster.js';
import { VALIDATION_SPECS as OPTIONS_SPECS } from '../../packages/options/src/generated/validation-specs.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('generated validation specs (3B.1b)', () => {
  it('the committed modules match a fresh projection exactly', async () => {
    // `validation:update` prettier-formats the emission before committing, so the comparison runs
    // the fresh projection through the SAME formatter and demands byte equality — a formatting
    // difference is then impossible and every remaining difference is real drift.
    const { modules } = generateValidationSpecs();
    for (const [directory, fresh] of modules) {
      const target = join(ROOT, 'packages', directory, 'src', 'generated', 'validation-specs.ts');
      const committed = readFileSync(target, 'utf8');
      const options = (await resolveConfig(target)) ?? {};
      const formatted = await format(fresh, { ...options, parser: 'typescript' });
      expect(
        committed,
        `packages/${directory}/src/generated/validation-specs.ts has drifted — run \`pnpm validation:update\``,
      ).toBe(formatted);
    }
  });

  it('every rostered boundary resolves and yields at least one object spec', () => {
    const { modules } = generateValidationSpecs(); // throws on an unresolvable roster row
    for (const roster of VALIDATION_ROSTER) {
      const directory = roster.package.replace('@totalfinance/', '');
      const source = modules.get(directory);
      expect(source, `${roster.package} produced no module`).toBeDefined();
      for (const boundary of roster.boundaries) {
        expect(
          source!.includes(`'${boundary}#`),
          `${boundary} resolved to no object parameter — a rostered boundary with nothing to validate is a stale row`,
        ).toBe(true);
      }
    }
  });

  it('every enum field carries its literal domain', () => {
    // An enum spec without literals validates nothing while looking like it validates something.
    const offenders: string[] = [];
    const walk = (
      fields: readonly {
        name: string;
        kind: string;
        literals?: readonly unknown[];
        fields?: readonly never[];
        branches?: readonly { fields: readonly never[] }[];
      }[],
      where: string,
    ): void => {
      for (const field of fields) {
        if (
          field.kind === 'enum' &&
          (field.literals === undefined || field.literals.length === 0)
        ) {
          offenders.push(`${where}.${field.name}`);
        }
        if (field.fields) walk(field.fields, `${where}.${field.name}`);
        for (const branch of field.branches ?? []) walk(branch.fields, `${where}.${field.name}`);
      }
    };
    for (const [key, spec] of Object.entries(OPTIONS_SPECS)) walk(spec.fields as never, key);
    expect(offenders).toEqual([]);
  });

  it('the barrier intersection keeps its inline members — the over-closure regression', () => {
    // The spec history's blocking condition: the intersection record used to omit every member
    // declared inline, so a key list closed on it would have rejected `type` and `barrierType` —
    // refusing valid calls in the name of fixing permissiveness, the worse defect of the two.
    const spec = OPTIONS_SPECS['barrier.price#0'];
    expect(spec).toBeDefined();
    const names = spec!.fields.map((field) => field.name);
    expect(names).toContain('type');
    expect(names).toContain('barrierType');
    const barrierType = spec!.fields.find((field) => field.name === 'barrierType');
    expect(barrierType?.literals).toEqual(['down-in', 'down-out', 'up-in', 'up-out']);
  });
});

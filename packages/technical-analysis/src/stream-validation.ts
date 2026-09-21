/**
 * Constructor-boundary validation for the public Stream classes (spec 3B.1b).
 *
 * The facades validate through `makeIndicator`'s resolve step, but the exported Stream classes are
 * a BACK DOOR beside that front door: `new AlmaStream({ period: null })` built a stream whose
 * state was `weights: [null], denom: 0` with no error — 68 constructors were convicted on every
 * mutation class. A constructor takes fully RESOLVED parameters (the facade applies declared
 * defaults before constructing), so its contract is all-required and validates against the same
 * checker-generated specs as every other boundary.
 *
 * This module is package-internal — absent from the exports map, like the generated specs it reads.
 */

import { validateClosedRequest } from '@totalfinance/core';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

export function requireStreamParameters(
  specKey: string,
  className: string,
  parameters: unknown,
): void {
  const specification = VALIDATION_SPECS[specKey];
  if (specification === undefined) {
    throw new Error(
      `${className}: no generated validation spec for '${specKey}' — run \`pnpm validation:update\``,
    );
  }
  validateClosedRequest(className, parameters, specification, {
    argumentName: 'parameters',
    subject: true,
    // A constructor's values are inherently caller-specific, so the useful correction (C11) is the
    // key skeleton plus the real front door: the facade's stream factory applies the declared
    // defaults this raw constructor deliberately does not.
    exampleCall: () => {
      const required = specification.fields
        .filter((field) => field.optional !== true)
        .map((field) => field.name)
        .join(', ');
      return `new ${className}({ ${required} }) — every parameter RESOLVED; prefer the indicator's .stream(…) factory, which applies the declared defaults`;
    },
  });
}

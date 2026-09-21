/**
 * The three identities a parameter has, spelled once so the generators and the gates cannot drift.
 *
 * RV12 ruled that "the parameter" is not one thing, and that conflating the three is why the
 * intersection gate could compare a set of labels and still learn nothing about the partition:
 *
 * 1. **Public parameter occurrence** — a parameter of a signature reachable at a documented export
 *    path. `totalfinance:options.barrier.monteCarloPrice` and `@totalfinance/options:barrier.monteCarloPrice`
 *    are TWO public occurrences.
 * 2. **Implementation parameter occurrence** — the same slot on the declaration those paths resolve
 *    to. Both of the above are ONE implementation occurrence.
 * 3. **Declared contract identity** — the named type filling the slot, which is shared far more
 *    widely still (one type can fill hundreds of slots).
 *
 * Identity is POSITIONAL, never by parameter name. A name is a fine diagnostic and a bad key: it is
 * not unique within a callable's overloads, the generator and the checker can spell a destructured
 * parameter differently, and renaming a parameter is not supposed to change which slot it is.
 */

/** `<base>|sig<N>|arg<M>` — positional, so a rename cannot silently repartition the set. */
function occurrence(base: string, signatureIndex: number, parameterIndex: number): string {
  return `${base}|sig${signatureIndex}|arg${parameterIndex}`;
}

/** Identity 1 — keyed by the documented export path (`<package>:<callable>`). */
export function publicParameterOccurrence(
  publicPathId: string,
  signatureIndex: number,
  parameterIndex: number,
): string {
  return occurrence(publicPathId, signatureIndex, parameterIndex);
}

/** Identity 2 — keyed by the declaration site (`packages/<pkg>/dist/<file>.d.ts#<owner>`). */
export function implementationParameterOccurrence(
  implementation: string,
  signatureIndex: number,
  parameterIndex: number,
): string {
  return occurrence(implementation, signatureIndex, parameterIndex);
}

/**
 * An implementation the generator could not resolve to a declaration site.
 *
 * Kept as a named predicate rather than an inline falsiness check because "unresolved" must fail a
 * gate loudly: an unresolved implementation silently collapses every public path that shares it onto
 * one key, which would make a divergence between those paths look like agreement.
 */
export function isUnresolvedImplementation(implementation: string | undefined): boolean {
  return !implementation || !implementation.includes('#');
}

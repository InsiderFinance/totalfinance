/**
 * Registry profiles (Stage 7A Decision 6): a named, exact selection of packs — the same registry a
 * worker rebuilds by name, so a job runs against exactly the set its submitter saw.
 */

import { ErrorCode, InputError } from '@totalfinance/core';
import { tradePack } from '../operations-trade.js';
import {
  backtestPack,
  createOperationRegistry,
  defaultPacks,
  journeyPacks,
  optionsPack,
  researchPack,
  strategyPack,
  portfolioPack,
  valuationPack,
  scenarioPack,
  riskPack,
  performancePack,
  artifactPack,
  volatilityPack,
  type OperationPack,
  type OperationRegistry,
} from '../index.js';

// One selection registry: names and discovery descriptions (derived from these packs' titles)
// cannot drift between transports. Profiles select operations; they NEVER grant capabilities.
const PROFILE_PACKS = {
  default: defaultPacks,
  options: () => [optionsPack(), volatilityPack()],
  research: () => [researchPack()],
  strategies: () => [optionsPack(), strategyPack(), volatilityPack()],
  portfolio: () => [portfolioPack(), riskPack(), performancePack(), artifactPack()],
  valuation: () => [valuationPack()],
  backtesting: () => [backtestPack(), performancePack(), artifactPack()],
  scenarios: () => [scenarioPack(), artifactPack()],
  full: () => [...defaultPacks(), ...journeyPacks(), backtestPack(), tradePack()],
} as const;

export type RegistryProfile = keyof typeof PROFILE_PACKS;

export const REGISTRY_PROFILES: readonly RegistryProfile[] = Object.freeze(
  Object.keys(PROFILE_PACKS) as RegistryProfile[],
);

/** The packs a profile selects — `full` is every shipped pack, the journey packs and the backtests included. */
export function packsForProfile(profile: RegistryProfile): OperationPack[] {
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILE_PACKS, profile)) {
    throw new InputError(
      `packsForProfile: profile must be one of ${REGISTRY_PROFILES.join(', ')}. Received ${JSON.stringify(profile)}.`,
      {
        code: typeof profile === 'string' ? ErrorCode.InputInvalidEnum : ErrorCode.InputWrongType,
        context: { function: 'packsForProfile', field: 'profile' },
      },
    );
  }
  return PROFILE_PACKS[profile]();
}

/** The registry for a profile, optionally narrowed to named packs (`--packs a,b`). */
export function registryForProfile(input: {
  profile: RegistryProfile;
  packs?: readonly string[];
}): OperationRegistry {
  const functionName = 'registryForProfile';
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError(`${functionName}: input must be an object ({ profile, packs? }).`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: 'input' },
    });
  }
  for (const key of Object.keys(input)) {
    if (key !== 'profile' && key !== 'packs') {
      throw new InputError(
        `${functionName}: unknown field "${key}" in input. Allowed fields: profile, packs.`,
        {
          code: ErrorCode.InputUnknownField,
          context: { function: functionName, field: 'input', key },
        },
      );
    }
  }
  const available = packsForProfile(input.profile);
  if (input.packs === undefined) return createOperationRegistry({ packs: available });
  if (!Array.isArray(input.packs) || input.packs.some((name) => typeof name !== 'string')) {
    throw new InputError(`${functionName}: packs must be an array of pack names when present.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: 'input.packs' },
    });
  }
  const byName = new Map(available.map((pack) => [pack.name, pack] as const));
  if (new Set(input.packs).size !== input.packs.length) {
    throw new InputError(`${functionName}: packs must name each selected pack only once.`, {
      code: ErrorCode.InputWrongShape,
      context: { function: functionName, field: 'input.packs' },
    });
  }
  const selected = input.packs.map((name) => {
    const pack = byName.get(name);
    if (!pack) {
      throw new InputError(
        `${functionName}: pack '${name}' is not in the '${input.profile}' profile. Available: ${[...byName.keys()].join(', ')}.`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { function: functionName, field: 'input.packs', name },
        },
      );
    }
    return pack;
  });
  return createOperationRegistry({ packs: selected });
}

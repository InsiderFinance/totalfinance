import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { registryForProfile } from '@totalfinance/workflows/local';
import { CLI_FIXTURES } from './cli.js';
import { synthesizeArguments, type SynthesisParameter } from '../../manifest/contract-synthesis.js';

it('the CLI registry receiver fixture runs against the actual synthesized profile', () => {
  const contracts = JSON.parse(
    readFileSync(new URL('../../manifest/public-contracts.json', import.meta.url), 'utf8'),
  ) as {
    contracts: {
      id: string;
      fields: string[];
      signatures: { parameters: SynthesisParameter[] }[];
    }[];
  };
  const factory = contracts.contracts.find(
    (record) => record.id === '@totalfinance/cli:registryForProfile',
  )!;
  const args = synthesizeArguments(factory.signatures[0]!.parameters, factory.fields);
  expect(args).not.toBeNull();
  const registry = registryForProfile(args![0] as Parameters<typeof registryForProfile>[0]);
  const request = CLI_FIXTURES['cli.OperationRegistry#run']!()[0] as Parameters<
    typeof registry.run
  >[0];
  const result = registry.run(request);
  expect(result.structured).toMatchObject({ value: { periods: 3 } });
});

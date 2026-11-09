// OT-RFC-27 script support: deployments/parameters.json, as the deploy reads
// it for base_sepolia_v10: "testnet", with that network's overrides, through
// the deploy helper's own reader.

import * as fs from 'fs';

import { ParametersConfig, contractParameters } from '../../utils/helpers';

export const PARAMETERS_JSON = 'deployments/parameters.json';

/**
 * What parameters.json, as parsed, sets on base_sepolia_v10 for the first of
 * `keys` it holds on `contract`, each the getter the deploy compares; of a list
 * of values, the last is the one that stays set.
 */
export function expectedParameterIn(all: ParametersConfig, contract: string, keys: string[]): { key: string; value: bigint } | undefined {
  const parameters = contractParameters(all, 'testnet', 'base_sepolia_v10', contract);
  for (const key of keys) {
    const value: unknown = parameters[key]?.at(-1)?.desiredValue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return { key, value: BigInt(value) };
  }
  return undefined;
}

/** expectedParameterIn over deployments/parameters.json; it must set one of `keys`. */
export function requireParameter(contract: string, keys: string[]): { key: string; value: bigint } {
  const p = expectedParameterIn(JSON.parse(fs.readFileSync(PARAMETERS_JSON, 'utf8')) as ParametersConfig, contract, keys);
  if (!p) throw new Error(`${PARAMETERS_JSON} "testnet" sets none of ${keys.join(', ')} on ${contract}`);
  return p;
}

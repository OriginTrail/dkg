// OT-RFC-27 script support: deployments/parameters.json, as the deploy reads
// it for base_sepolia_v10: "testnet", with that network's overrides.

import * as fs from 'fs';

export const PARAMETERS_JSON = 'deployments/parameters.json';

type ParameterValue = string | number | { setter?: string; setterArgs?: unknown[]; desiredValue?: unknown } | ParameterValue[];

const record = (x: unknown): Record<string, unknown> => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

/** The parameters the deploy sets on `contract` on base_sepolia_v10, from parameters.json as parsed: "testnet", with that network's overrides. */
function testnetParameters(all: unknown, contract: string): Record<string, unknown> {
  const testnet = record(record(all).testnet);
  return { ...record(testnet[contract]), ...record(record(record(testnet.overrides).base_sepolia_v10)[contract]) };
}

/** The value a parameter entry asks for, as the deploy's helper reads it: a value, or `{ setter, setterArgs }`. */
function desired(value: ParameterValue): bigint | undefined {
  if (Array.isArray(value)) return value.length ? desired(value[value.length - 1]) : undefined;
  if (typeof value === 'object' && value !== null) {
    const v = value.setterArgs && value.setterArgs.length === 1 ? value.setterArgs[0] : value.desiredValue;
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' ? BigInt(v) : undefined;
  }
  return BigInt(value);
}

/**
 * What parameters.json, as parsed, sets on base_sepolia_v10 for the first of
 * `keys` it holds on `contract`. A key may name the getter the deploy
 * compares, such as `latestLambdaBps`, or the parameter, such as `lambdaBps`;
 * its value is a value, `{ setter, setterArgs }`, or a list of them.
 */
export function expectedParameterIn(all: unknown, contract: string, keys: string[]): { key: string; value: bigint } | undefined {
  const p = testnetParameters(all, contract);
  for (const key of keys) {
    if (p[key] === undefined) continue;
    const value = desired(p[key] as ParameterValue);
    if (value !== undefined) return { key, value };
  }
  return undefined;
}

/** expectedParameterIn over deployments/parameters.json; it must set one of `keys`. */
export function requireParameter(contract: string, keys: string[]): { key: string; value: bigint } {
  const p = expectedParameterIn(JSON.parse(fs.readFileSync(PARAMETERS_JSON, 'utf8')), contract, keys);
  if (!p) throw new Error(`${PARAMETERS_JSON} "testnet" sets none of ${keys.join(', ')} on ${contract}`);
  return p;
}

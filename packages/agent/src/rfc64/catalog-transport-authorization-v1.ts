// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64CatalogAccessAuthorizationInputV1,
  Rfc64CatalogAccessAuthorizationV1,
  Rfc64CatalogAccessPolicyRegistryV1,
} from './catalog-access-policy-v1.js';

export type Rfc64LegacyOpenCatalogAuthorizerV1<
  Input extends Rfc64CatalogAccessAuthorizationInputV1,
> = (input: Input) => Promise<Rfc64CatalogAccessAuthorizationV1 | null>;

/**
 * Collapse the V2 registry and the deprecated open-only callback into one
 * transport-facing authorizer. The legacy callback is deliberately incapable
 * of authorizing a private cell: private access requires the current registry's
 * authenticated peer-to-wallet and member-role checks.
 */
export function normalizeRfc64CatalogTransportAuthorizerV1<
  Input extends Rfc64CatalogAccessAuthorizationInputV1,
>(options: {
  readonly current?: Rfc64CatalogAccessPolicyRegistryV1['authorize'];
  readonly legacyOpen?: Rfc64LegacyOpenCatalogAuthorizerV1<Input>;
  readonly invalidConfiguration: (message: string) => never;
}): Rfc64LegacyOpenCatalogAuthorizerV1<Input> {
  const current = options.current;
  const legacyOpen = options.legacyOpen;
  if (
    (typeof current !== 'function' && typeof legacyOpen !== 'function')
    || (typeof current === 'function' && typeof legacyOpen === 'function')
  ) {
    return options.invalidConfiguration(
      'exactly one catalog access-policy authorizer must be configured',
    );
  }
  if (typeof current === 'function') {
    return (input) => current(projectCatalogAccessAuthorizationInput(input));
  }
  return async (input) => {
    const authorization = await legacyOpen!(input);
    return authorization?.accessPolicy === 0 ? authorization : null;
  };
}

/**
 * Apply the same accepted-current policy before and after an awaited boundary.
 * This closes policy-generation and membership TOCTOU windows without making
 * each transport flow reproduce the checkpoint choreography.
 */
export async function withCurrentRfc64CatalogPolicyV1<Value>(
  requireCurrentPolicy: () => Promise<void>,
  work: () => Value | Promise<Value>,
): Promise<Value> {
  await requireCurrentPolicy();
  const value = await work();
  await requireCurrentPolicy();
  return value;
}

export async function recheckCurrentRfc64CatalogPolicyAfterAwaitV1<Value>(
  requireCurrentPolicy: () => Promise<void>,
  work: () => Value | Promise<Value>,
): Promise<Value> {
  const value = await work();
  await requireCurrentPolicy();
  return value;
}

export type Rfc64AuthorizedCatalogWorkResultV1<Value> =
  | { readonly authorized: true; readonly value: Value }
  | { readonly authorized: false };

export async function withAuthorizedCurrentRfc64CatalogPolicyV1<Value>(
  isCurrentPolicyAuthorized: () => Promise<boolean>,
  work: () => Value | Promise<Value>,
): Promise<Rfc64AuthorizedCatalogWorkResultV1<Value>> {
  if (!await isCurrentPolicyAuthorized()) return Object.freeze({ authorized: false });
  const value = await work();
  if (!await isCurrentPolicyAuthorized()) return Object.freeze({ authorized: false });
  return Object.freeze({ authorized: true, value });
}

function projectCatalogAccessAuthorizationInput(
  input: Rfc64CatalogAccessAuthorizationInputV1,
): Rfc64CatalogAccessAuthorizationInputV1 {
  return Object.freeze({
    operation: input.operation,
    remotePeerId: input.remotePeerId,
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    policyDigest: input.policyDigest,
  });
}

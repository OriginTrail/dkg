// SPDX-License-Identifier: Apache-2.0
import type { ResolvedDKGAgentConfig } from '../src/dkg-agent-types.js';
import type { Rfc64PublicCatalogServiceV1 } from '../src/rfc64/public-catalog-service-v1.js';
import { resolveRfc64PrivateReadRoster } from '../src/rfc64/private-read-roster-v1.js';

declare const config: Pick<ResolvedDKGAgentConfig, 'networkIdentity' | 'rfc64CatalogBootstrap'>;
declare const lookup: Pick<Rfc64PublicCatalogServiceV1, 'acceptedPolicySnapshot'>;
const result: readonly string[] | null | undefined = resolveRfc64PrivateReadRoster({
  config, service: lookup, isJoinDerived: () => false,
}, 'private-read');
resolveRfc64PrivateReadRoster({
  config: {}, service: { acceptedPolicySnapshot: () => null }, isJoinDerived: () => false,
}, 'private-read');
// @ts-expect-error A lookup that returns unavailable as undefined violates its authority contract.
resolveRfc64PrivateReadRoster({ config, service: { acceptedPolicySnapshot: () => undefined }, isJoinDerived: () => false }, 'private-read');
void result;

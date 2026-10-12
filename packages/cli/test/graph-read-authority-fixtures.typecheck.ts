// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphReadAuthorityDecision, DKGAgent } from '@origintrail-official/dkg-agent';

const caller: ContextGraphReadAuthorityDecision = { outcome: 'allowed', grantScope: 'caller', source: 'registered-chain', reason: 'diagnostic', metadataBootstrap: 'eligible' };
const resolve: DKGAgent['resolveContextGraphReadAuthority'] = async () => caller;
void resolve;
// @ts-expect-error Authoritative refusal cannot grant caller scope.
const contradictory: ContextGraphReadAuthorityDecision = { outcome: 'denied', grantScope: 'caller', source: 'registered-chain', reason: 'diagnostic', metadataBootstrap: 'forbidden' };
// @ts-expect-error Authority fixtures must supply the canonical metadata-bootstrap policy.
const incomplete: ContextGraphReadAuthorityDecision = { outcome: 'allowed', grantScope: 'caller', source: 'registered-chain', reason: 'diagnostic' };
void [contradictory, incomplete];

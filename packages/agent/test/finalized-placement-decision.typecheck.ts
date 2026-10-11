import type { DKGAgent } from '../src/dkg-agent.js';
import type { CanonicalGraphScopedAuthorSealV1, AuthorCatalogScopeV1 } from '@origintrail-official/dkg-core';
import type { FinalizedPlacementDecisionV1 } from '../src/internal/finalized-placement-decision.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../src/rfc64/finalized-private-placement-repair-store-v1.js';

declare const agent: DKGAgent;
declare const repair: Extract<Rfc64FinalizedPrivatePlacementRepairV1, { version: 2 }>;
declare const seal: CanonicalGraphScopedAuthorSealV1;
declare const ready: Extract<FinalizedPlacementDecisionV1, { status: 'ready' }>;
declare const scope: AuthorCatalogScopeV1;
agent.requestRfc64FinalizedPrivateCatalogPlacementRepairV1({ repair });
// @ts-expect-error V2 requests own their seal in the durable record, with no second seal channel.
agent.requestRfc64FinalizedPrivateCatalogPlacementRepairV1({ repair, seal });
// @ts-expect-error Public retirement cannot reserve a private catalog capacity scope.
const invalid: FinalizedPlacementDecisionV1 = { ...ready, action: 'retire-public-row', capacityScope: scope };
void invalid;

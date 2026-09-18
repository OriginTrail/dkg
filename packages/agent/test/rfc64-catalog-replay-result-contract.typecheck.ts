// SPDX-License-Identifier: Apache-2.0

// `.test.ts` files are not part of any tsconfig, so a replay-completion fixture that
// omits a required counter compiles everywhere and is caught by nobody. Pin the shape
// here, in the one test lane `pnpm --filter @origintrail-official/dkg-agent run build`
// actually type-checks, so the next counter added to the completion breaks loudly.

import type { DKGAgent } from '../src/dkg-agent.js';
import type {
  Rfc64PublicCatalogHeadReplayProviderCompletionV2,
} from '../src/rfc64/public-catalog-transport-v1.js';

type Rfc64CatalogReplayResultV1 = Awaited<
  ReturnType<DKGAgent['reannounceRfc64CatalogHeadsToPeerV1']>
>;

const emptyReplay: Rfc64CatalogReplayResultV1 = {
  announced: 0,
  failed: 0,
  withheld: 0,
  manifest: [],
};
void emptyReplay;

// @ts-expect-error A replay result must report how many stored heads it withheld.
const missingWithheld: Rfc64CatalogReplayResultV1 = {
  announced: 0,
  failed: 0,
  manifest: [],
};
void missingWithheld;

// The provider's own completion crosses into the transport, which decides between a
// `completed` and an `incomplete` answer from `withheld`. Anything the agent can return
// has to be a legal completion there.
const asProviderCompletion: Rfc64PublicCatalogHeadReplayProviderCompletionV2 = emptyReplay;
void asProviderCompletion;

import type { DurableSyncOptions } from '../src/dkg-agent-lifecycle.js';
import type { DKGAgent } from '../src/dkg-agent.js';

type ExactOptions = NonNullable<Parameters<DKGAgent['syncExactKnowledgeAssetsFromPeerDetailed']>[3]>;

const modes = ['legacy', 'stream-preferred', 'stream-required'] as const;
for (const exactRecoveryTransportMode of modes) {
  const durable: DurableSyncOptions = { exactRecoveryTransportMode };
  const exact: ExactOptions = { exactRecoveryTransportMode };
  void durable;
  void exact;
}

// @ts-expect-error Recovery transport decisions are a closed union.
const invalid: DurableSyncOptions = { exactRecoveryTransportMode: 'automatic' };
// @ts-expect-error The contradictory boolean pair is no longer part of dispatch.
const removedOnly: DurableSyncOptions = { experimentalExactBatchStreamOnly: true };
// @ts-expect-error Exact APIs cannot opt into a separate disabling flag.
const removedDisabled: ExactOptions = { experimentalExactBatchStreamDisabled: true };
void invalid;
void removedOnly;
void removedDisabled;

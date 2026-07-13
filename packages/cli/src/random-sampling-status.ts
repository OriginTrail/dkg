import type { RandomSamplingDisabledReason } from '@origintrail-official/dkg-agent';
import type { RandomSamplingStatusResponse } from './api-client.js';

type DisabledStatus = Pick<
  RandomSamplingStatusResponse,
  'role' | 'identityId' | 'disabledReason'
>;

const DISABLED_REASON_MESSAGES: Record<RandomSamplingDisabledReason, string> = {
  edge_node: 'edge node — random sampling is core-only',
  no_identity: 'no on-chain identity yet (complete profile registration and staking)',
  awaiting_sharding_table: 'profile exists; waiting for sharding-table admission',
  identity_lookup_failed: 'identity lookup failed; the node will retry',
  eligibility_lookup_failed: 'sharding-table lookup failed; the node will retry',
  unsupported_chain: 'chain adapter does not support Random Sampling',
  contracts_not_deployed: 'Random Sampling contracts are not available on this network',
  bind_failed: 'prover setup failed; inspect daemon logs',
  not_started: 'prover has not started yet',
};

export function describeRandomSamplingDisabledStatus(status: DisabledStatus): string {
  if (status.disabledReason) {
    return DISABLED_REASON_MESSAGES[status.disabledReason];
  }
  if (status.role !== 'core') return 'edge node — random sampling is core-only';
  if (status.identityId === '0') {
    return 'no on-chain identity yet (complete profile registration and staking)';
  }
  return 'prover unavailable; inspect daemon logs';
}

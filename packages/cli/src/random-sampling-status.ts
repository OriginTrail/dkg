import type { RandomSamplingStatusResponse } from './api-client.js';

type DisabledStatus = Pick<
  RandomSamplingStatusResponse,
  'role' | 'identityId' | 'disabledReason'
>;

export function describeRandomSamplingDisabledStatus(status: DisabledStatus): string {
  switch (status.disabledReason) {
    case 'edge_node':
      return 'edge node — random sampling is core-only';
    case 'no_identity':
      return 'no on-chain identity yet (complete profile registration and staking)';
    case 'awaiting_sharding_table':
      return 'profile exists; waiting for sharding-table admission';
    case 'identity_lookup_failed':
      return 'identity lookup failed; the node will retry';
    case 'eligibility_lookup_failed':
      return 'sharding-table lookup failed; the node will retry';
    case 'unsupported_chain':
      return 'chain adapter does not support Random Sampling';
    case 'contracts_not_deployed':
      return 'Random Sampling contracts are not available on this network';
    case 'bind_failed':
      return 'prover setup failed; inspect daemon logs';
    case 'not_started':
      return 'prover has not started yet';
    default:
      if (status.role !== 'core') return 'edge node — random sampling is core-only';
      if (status.identityId === '0') {
        return 'no on-chain identity yet (complete profile registration and staking)';
      }
      return 'prover unavailable; inspect daemon logs';
  }
}

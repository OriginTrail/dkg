import type { ChainIdV1 } from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';
import { snapshotStrictCurrentFinalizedEvmConfigV1 } from '../src/strict-current-finalized-evm-config.js';
import { createStrictCurrentFinalizedEvmChainAdapterV1, type StrictCurrentFinalizedEvmRpcConfigV1 } from '../src/strict-current-finalized-evm-rpc.js';
import {
  CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1,
  CONTROL_EIP1271_CALL_FROM_V1,
  CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1,
  CONTROL_EIP1271_GAS_LIMIT_V1,
  CONTROL_EIP1271_MAX_ATTEMPTS_V1,
  CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1,
  CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1,
  CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1,
} from '../src/control-object-signature-verifier.js';
import {
  CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
  CURRENT_FINALIZED_EVM_READ_CALL_FROM_V1,
  CURRENT_FINALIZED_EVM_READ_ENDPOINT_ATTEMPT_POLICY_V1,
  CURRENT_FINALIZED_EVM_READ_GAS_LIMIT_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1,
  CURRENT_FINALIZED_EVM_READ_TOTAL_DEADLINE_MS_V1,
} from '../src/current-finalized-evm-read-profile.js';

const CHAIN_ID = '20430' as ChainIdV1;

describe('strict current-finalized RPC configuration', () => {
  it('keeps the EIP-1271 specialization pinned to the generic finalized-read profile', () => {
    expect(CONTROL_EIP1271_CALL_FROM_V1).toBe(CURRENT_FINALIZED_EVM_READ_CALL_FROM_V1);
    expect(CONTROL_EIP1271_GAS_LIMIT_V1).toBe(CURRENT_FINALIZED_EVM_READ_GAS_LIMIT_V1);
    expect(CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1)
      .toBe(CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1);
    expect(CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1)
      .toBe(CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1);
    expect(CONTROL_EIP1271_MAX_ATTEMPTS_V1)
      .toBe(CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1);
    expect(CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1)
      .toBe(CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1);
    expect(CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1)
      .toBe(CURRENT_FINALIZED_EVM_READ_TOTAL_DEADLINE_MS_V1);
    expect(CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1)
      .toBe(CURRENT_FINALIZED_EVM_READ_ENDPOINT_ATTEMPT_POLICY_V1);
  });

  it('rejects unsafe configuration', () => {
    const third = 'http://127.0.0.1:3';
    for (const config of [
      { chainId: '020430', endpoints: ['http://127.0.0.1:1'] },
      { chainId: CHAIN_ID, endpoints: [] },
      { chainId: CHAIN_ID, endpoints: ['ftp://127.0.0.1/a'] },
      { chainId: CHAIN_ID, endpoints: ['http://127.0.0.1/a#fragment'] },
      { chainId: CHAIN_ID, endpoints: ['https://user:pass@rpc.example.com'] },
      { chainId: CHAIN_ID, endpoints: ['http://127.0.0.1:1'], peerEndpoint: third },
    ]) {
      expect(() => createStrictCurrentFinalizedEvmChainAdapterV1(
        config as StrictCurrentFinalizedEvmRpcConfigV1,
      )).toThrow(TypeError);
    }
  });

  it('selects the first two origins from a larger configured pool', () => {
    // Shipped EVM networks have three RPC URLs. Exercise the complete config
    // boundary and pin which providers reach the two-attempt session.
    const selection = snapshotStrictCurrentFinalizedEvmConfigV1({
      chainId: CHAIN_ID,
      endpoints: ['http://127.0.0.1:1', 'http://127.0.0.1:2', 'http://127.0.0.1:3'],
    } as never).endpoints;
    // Distinct ports are distinct origins, so this session really does carry two
    // providers — and the third is dropped, not merged.
    expect(selection).toEqual(['http://127.0.0.1:1/', 'http://127.0.0.1:2/']);

    expect(() => createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [
        'http://127.0.0.1:1',
        'http://127.0.0.1:2',
        'http://127.0.0.1:3',
      ],
    } as StrictCurrentFinalizedEvmRpcConfigV1)).not.toThrow();
  });
});

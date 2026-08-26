import type {
  ContextGraphPolicyV1,
  Digest32V1,
  MemberRosterV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRfc64FinalizedPolicyAgentPrecommitV1 } from '../src/rfc64/finalized-policy-agent-precommit-v1.js';
import {
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcError,
  sendJsonRpcResult,
} from '../../chain/test/loopback-rpc-harness.js';
import {
  RFC64_VM_AUTHOR,
  RFC64_VM_BLOCK_HASH,
  RFC64_VM_CG_STORAGE,
  RFC64_VM_CHAIN_ID,
  RFC64_VM_CONTEXT_GRAPH_NAME,
  RFC64_VM_KAV10,
  RFC64_VM_KA_STORAGE,
  RFC64_VM_NETWORK_ID,
  RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
  RFC64_VM_POLICY_DIGEST,
} from './support/rfc64-finalized-vm-placement-fixture.js';
import {
  acceptedRfc64VmPolicySnapshot,
  rfc64FinalizedVmPrecommitOptions,
  rfc64FinalizedVmPrecommitPlan,
} from './support/rfc64-finalized-vm-precommit-fixture.js';
import {
  createFinalizedVmLoopbackRpcV1,
  type FinalizedVmLoopbackFixtureConfigV1,
} from './support/rfc64-finalized-vm-loopback-fixture.js';

const rpcHarness = createLoopbackJsonRpcTestHarness();

afterEach(async () => {
  await rpcHarness.stopAll();
});

function options() {
  const fixture = rfc64FinalizedVmPrecommitOptions();
  return {
    acceptedPolicySnapshotForCatalogScope: fixture.acceptedPolicySnapshotForCatalogScope,
    rpcEndpoints: fixture.rpcEndpoints,
    getOnChainContextGraphId: fixture.getOnChainContextGraphId,
    getEvmChainId: fixture.getEvmChainId,
  };
}

function finalizedChainFixture(
  overrides: Partial<FinalizedVmLoopbackFixtureConfigV1> = {},
): FinalizedVmLoopbackFixtureConfigV1 {
  return {
    accessPolicy: 0,
    active: true,
    assertedAtChainId: RFC64_VM_CHAIN_ID,
    assertedAtKav10Address: RFC64_VM_KAV10,
    knowledgeAssetStorageAddress: RFC64_VM_KA_STORAGE,
    assets: [],
    blockHash: RFC64_VM_BLOCK_HASH,
    blockNumberQuantity: '0x7c',
    contextGraphStorageAddress: RFC64_VM_CG_STORAGE,
    nameHash: ethers.keccak256(ethers.toUtf8Bytes(RFC64_VM_CONTEXT_GRAPH_NAME)) as never,
    networkId: RFC64_VM_NETWORK_ID,
    onChainContextGraphId: RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
    ownerAddress: RFC64_VM_AUTHOR,
    publishPolicy: 1,
    ...overrides,
  };
}

async function liveOptions(
  overrides: Partial<FinalizedVmLoopbackFixtureConfigV1> = {},
) {
  const rpc = createFinalizedVmLoopbackRpcV1(finalizedChainFixture(overrides));
  const server = await rpcHarness.start((call, response) => {
    try {
      sendJsonRpcResult(response, call, rpc.respond(call.method, call.params));
    } catch (cause) {
      sendJsonRpcError(
        response,
        call,
        -32602,
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  });
  return {
    options: { ...options(), rpcEndpoints: [server.url] },
    rpc,
  };
}

function acceptedPolicyWith(
  overrides: Partial<ContextGraphPolicyV1>,
) {
  const accepted = acceptedRfc64VmPolicySnapshot();
  return Object.freeze({
    ...accepted,
    policy: Object.freeze({ ...accepted.policy, ...overrides }),
  });
}

function privateOwnerSnapshot(policyDigest = RFC64_VM_POLICY_DIGEST) {
  const accepted = acceptedRfc64VmPolicySnapshot();
  const policy = Object.freeze({
    ...accepted.policy,
    governanceChainId: null,
    governanceContractAddress: null,
    accessPolicy: 1 as const,
    source: Object.freeze({
      kind: 'owner-signed-unregistered' as const,
      ownerAddress: RFC64_VM_AUTHOR,
      ownerAuthorityEra: '0' as const,
    }),
  });
  const roster = Object.freeze({
    networkId: policy.networkId,
    contextGraphId: policy.contextGraphId,
    ownershipTransitionDigest: policy.ownershipTransitionDigest,
    era: policy.era,
    version: '0',
    previousRosterDigest: null,
    policyDigest,
    administrativeDelegationDigest: policy.administrativeDelegationDigest,
    members: Object.freeze([Object.freeze({
      agentAddress: RFC64_VM_AUTHOR,
      roles: Object.freeze(['provider'] as const),
    })]),
    issuedAt: '1700000000000',
  }) satisfies MemberRosterV1;
  return Object.freeze({ policy, policyDigest, roster });
}

function privateOwnerPlan(policyDigest = RFC64_VM_POLICY_DIGEST) {
  const base = rfc64FinalizedVmPrecommitPlan();
  return Object.freeze({
    ...base,
    policyDigest,
    catalogScope: Object.freeze({
      ...base.catalogScope,
      governanceChainId: null,
      governanceContractAddress: null,
    }),
  });
}

describe('RFC-64 finalized policy agent precommit', () => {
  it('accepts a chain-bound SWM catalog without invoking VM materialization', async () => {
    const getOnChainContextGraphId = vi.fn(async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID);
    const getEvmChainId = vi.fn(async () => BigInt(RFC64_VM_CHAIN_ID));
    const live = await liveOptions();
    const handler = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...live.options,
      getOnChainContextGraphId,
      getEvmChainId,
    });

    await expect(handler(
      rfc64FinalizedVmPrecommitPlan(),
      new AbortController().signal,
    )).resolves.toBeUndefined();
    expect(getOnChainContextGraphId).toHaveBeenCalledWith(
      RFC64_VM_CONTEXT_GRAPH_NAME,
      expect.any(AbortSignal),
    );
    expect(getEvmChainId).toHaveBeenCalledOnce();
    expect(live.rpc.calls.filter((call) => (
      call.method === 'eth_call'
      && (call.params[0] as { data?: string } | undefined)?.data !== '0x'
    ))).toHaveLength(2);
  });

  it('rejects before chain resolution when trusted RPC endpoints are absent', async () => {
    const getOnChainContextGraphId = vi.fn(async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID);
    const getEvmChainId = vi.fn(async () => BigInt(RFC64_VM_CHAIN_ID));
    const handler = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...options(),
      rpcEndpoints: [],
      getOnChainContextGraphId,
      getEvmChainId,
    });

    await expect(handler(
      rfc64FinalizedVmPrecommitPlan(),
      new AbortController().signal,
    )).rejects.toThrow('requires trusted RPC configuration');
    expect(getOnChainContextGraphId).not.toHaveBeenCalled();
    expect(getEvmChainId).not.toHaveBeenCalled();
  });

  it('leaves non-finalized owner policy outside the EVM precommit lane', async () => {
    const getOnChainContextGraphId = vi.fn(async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID);
    const getEvmChainId = vi.fn(async () => BigInt(RFC64_VM_CHAIN_ID));
    const handler = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...options(),
      acceptedPolicySnapshotForCatalogScope: () => acceptedPolicyWith({
        governanceChainId: null,
        governanceContractAddress: null,
        source: {
          kind: 'owner-signed-unregistered',
          ownerAddress: RFC64_VM_AUTHOR,
          ownerAuthorityEra: '0',
        },
      }),
      getOnChainContextGraphId,
      getEvmChainId,
    });

    const finalizedPlan = rfc64FinalizedVmPrecommitPlan();
    await expect(handler(
      Object.freeze({
        ...finalizedPlan,
        catalogScope: Object.freeze({
          ...finalizedPlan.catalogScope,
          governanceChainId: null,
          governanceContractAddress: null,
        }),
      }),
      new AbortController().signal,
    )).resolves.toBeUndefined();
    expect(getOnChainContextGraphId).not.toHaveBeenCalled();
    expect(getEvmChainId).not.toHaveBeenCalled();
  });

  it('accepts a private unregistered SWM catalog only with its exact current roster', async () => {
    const current = privateOwnerSnapshot();
    const acceptedPolicySnapshotForCatalogScope = vi.fn(() => current);
    const getOnChainContextGraphId = vi.fn(async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID);
    const getEvmChainId = vi.fn(async () => BigInt(RFC64_VM_CHAIN_ID));
    const handler = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...options(),
      acceptedPolicySnapshotForCatalogScope,
      getOnChainContextGraphId,
      getEvmChainId,
    });

    await expect(handler(
      privateOwnerPlan(),
      new AbortController().signal,
    )).resolves.toBeUndefined();
    expect(acceptedPolicySnapshotForCatalogScope).toHaveBeenCalledTimes(2);
    expect(getOnChainContextGraphId).not.toHaveBeenCalled();
    expect(getEvmChainId).not.toHaveBeenCalled();
  });

  it('rejects private SWM when the roster is missing or the policy changes before commit', async () => {
    const exact = privateOwnerSnapshot();
    const missingRoster = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...options(),
      acceptedPolicySnapshotForCatalogScope: () => Object.freeze({
        ...exact,
        roster: null,
      }),
    });
    await expect(missingRoster(
      privateOwnerPlan(),
      new AbortController().signal,
    )).rejects.toThrow(/exact current policy-bound roster/u);

    const successorDigest = `0x${'a7'.repeat(32)}` as Digest32V1;
    const acceptedPolicySnapshotForCatalogScope = vi.fn()
      .mockReturnValueOnce(exact)
      .mockReturnValue(privateOwnerSnapshot(successorDigest));
    const changed = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...options(),
      acceptedPolicySnapshotForCatalogScope,
    });
    await expect(changed(
      privateOwnerPlan(),
      new AbortController().signal,
    )).rejects.toThrow(/accepted policy changed/u);
  });

  it('accepts a registered private catalog with the exact roster and live chain policy', async () => {
    const base = acceptedRfc64VmPolicySnapshot();
    const privateFinalized = Object.freeze({
      ...base,
      policy: Object.freeze({ ...base.policy, accessPolicy: 1 as const }),
      roster: privateOwnerSnapshot().roster,
    });
    const live = await liveOptions({ accessPolicy: 1 });
    const handler = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...live.options,
      acceptedPolicySnapshotForCatalogScope: () => privateFinalized,
    });
    await expect(handler(
      rfc64FinalizedVmPrecommitPlan(),
      new AbortController().signal,
    )).resolves.toBeUndefined();
  });

  it('rejects a missing CG mapping or a different live chain', async () => {
    const missingContextGraph = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...options(),
      getOnChainContextGraphId: async () => null,
    });
    await expect(missingContextGraph(
      rfc64FinalizedVmPrecommitPlan(),
      new AbortController().signal,
    )).rejects.toThrow('could not resolve the numeric context graph id');

    const differentChain = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...options(),
      getEvmChainId: async () => 1n,
    });
    await expect(differentChain(
      rfc64FinalizedVmPrecommitPlan(),
      new AbortController().signal,
    )).rejects.toThrow('differs from the configured chain id');
  });

  it.each([
    ['missing governance', {
      governanceChainId: null,
      governanceContractAddress: null,
    }],
    ['source/governance mismatch', {
      source: {
        ...acceptedRfc64VmPolicySnapshot().policy.source,
        contractAddress: `0x${'99'.repeat(20)}`,
      },
    }],
  ] as const)('rejects %s before resolving chain state', async (_label, policyOverrides) => {
    const getOnChainContextGraphId = vi.fn(async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID);
    const getEvmChainId = vi.fn(async () => BigInt(RFC64_VM_CHAIN_ID));
    const handler = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...options(),
      acceptedPolicySnapshotForCatalogScope: () => acceptedPolicyWith(
        policyOverrides as Partial<ContextGraphPolicyV1>,
      ),
      getOnChainContextGraphId,
      getEvmChainId,
    });

    await expect(handler(
      rfc64FinalizedVmPrecommitPlan(),
      new AbortController().signal,
    )).rejects.toThrow();
    expect(getOnChainContextGraphId).not.toHaveBeenCalled();
    expect(getEvmChainId).not.toHaveBeenCalled();
  });

  it('rejects a stale accepted policy that differs from live finalized chain state', async () => {
    const live = await liveOptions();
    const accepted = acceptedRfc64VmPolicySnapshot();
    const handler = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...live.options,
      acceptedPolicySnapshotForCatalogScope: () => acceptedPolicyWith({
        publishPolicy: 0,
        publishAuthority: RFC64_VM_AUTHOR,
        source: accepted.policy.source,
      }),
    });

    await expect(handler(
      rfc64FinalizedVmPrecommitPlan(),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'finalized-policy-verifier-policy',
    });
    expect(live.rpc.calls.filter((call) => (
      call.method === 'eth_call'
      && (call.params[0] as { data?: string } | undefined)?.data !== '0x'
    ))).toHaveLength(2);
  });
});

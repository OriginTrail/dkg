import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '../src/dkg-agent.js';
import { RegisteredPrivateEmptyVmMethods } from '../src/dkg-agent-registered-private-empty-vm.js';
import { resolveChainFinalityConfirmationsV1 } from '../src/chain-finality-confirmations-v1.js';
import {
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcError,
  sendJsonRpcResult,
} from '../../chain/test/loopback-rpc-harness.js';

const CG = 'registered-private-finality-test';
const CALLER = `0x${'11'.repeat(20)}`;
const GOVERNANCE = `0x${'22'.repeat(20)}`;
const HUB = `0x${'33'.repeat(20)}`;
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CG));
const BLOCK_HASH = `0x${'44'.repeat(32)}`;
const HEAD = 150;
const storage = new ethers.Interface([
  'function getContextGraph(uint256) view returns (address owner, address[] participantAgents, uint256 metadataBatchId, bool active, uint256 createdAt, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
  'function getNameHash(uint256) view returns (bytes32)',
  'function getContextGraphKaCount(uint256) view returns (uint256)',
]);
const hub = new ethers.Interface(['function getAssetStorageAddress(string) view returns (address)']);
const rpc = createLoopbackJsonRpcTestHarness();

afterEach(async () => { await rpc.stopAll(); });

async function proveAtDepth(depthFromAdapter?: number, depthFromConfig?: number, omitChainId = false) {
  const server = await rpc.start((call, response) => {
    switch (call.method) {
      case 'eth_chainId': sendJsonRpcResult(response, call, '0x7a69'); return;
      case 'eth_getBlockByNumber': {
        const number = call.params[0] === 'latest' ? HEAD : Number(call.params[0]);
        sendJsonRpcResult(response, call, {
          number: `0x${number.toString(16)}`,
          hash: number === HEAD ? `0x${'55'.repeat(32)}` : BLOCK_HASH,
        });
        return;
      }
      case 'eth_getCode': sendJsonRpcResult(response, call, '0x6000'); return;
      case 'eth_call': {
        const request = call.params[0] as { to: string; data: string };
        if (request.data === '0x') { sendJsonRpcResult(response, call, '0x'); return; }
        if (request.to.toLowerCase() === HUB) {
          const decoded = hub.parseTransaction({ data: request.data });
          expect(decoded?.name).toBe('getAssetStorageAddress');
          expect(decoded?.args[0]).toBe('ContextGraphStorage');
          sendJsonRpcResult(response, call, hub.encodeFunctionResult('getAssetStorageAddress', [GOVERNANCE]));
          return;
        }
        expect(request.to.toLowerCase()).toBe(GOVERNANCE);
        const decoded = storage.parseTransaction({ data: request.data })!;
        expect(decoded.args[0]).toBe(3n);
        switch (decoded.name) {
          case 'getContextGraph':
            sendJsonRpcResult(response, call, storage.encodeFunctionResult(decoded.name, [
              CALLER, [CALLER], 0n, true, 1n, 1, 1, ethers.ZeroAddress, 0n,
            ]));
            return;
          case 'getNameHash':
            sendJsonRpcResult(response, call, storage.encodeFunctionResult(decoded.name, [NAME_HASH]));
            return;
          case 'getContextGraphKaCount':
            sendJsonRpcResult(response, call, storage.encodeFunctionResult(decoded.name, [0n]));
            return;
          default: sendJsonRpcError(response, call, -32602, 'unexpected call');
        }
        return;
      }
      default: sendJsonRpcError(response, call, -32601, 'method not found');
    }
  });
  const agent = {
    subscribedContextGraphs: new Map([[CG, { subscribed: true }]]),
    contextGraphMetaProjection: { readContextGraphAuthorityFactsRevision: () => '0:0' },
    hasConfirmedMetaState: async () => true,
    isPrivateContextGraph: async () => true,
    resolveContextGraphSubscriptionBootstrapAuthority: async () => ({
      outcome: 'allowed', source: 'registered-chain', onChainId: 3n,
    }),
    readRfc64RegisteredAuthoritySnapshotV1: async () => ({
      expectedNameHash: NAME_HASH,
      expectedOnChainId: 3n,
      snapshot: {
        chainId: '31337', contextGraphId: '3', active: true, accessPolicy: 1,
        governanceContract: GOVERNANCE, nameHash: NAME_HASH,
      },
    }),
    contextGraphAuthorityReaderCapability: { status: 'supported', reader: {} },
    config: { chainConfig: {
      rpcUrl: server.url, hubAddress: HUB,
      ...(omitChainId ? {} : { chainId: 'evm:31337' }),
      ...(depthFromConfig === undefined ? {} : { finalityConfirmations: depthFromConfig }),
    } },
    chain: {
      getEvmChainId: async () => 31337n,
      ...(depthFromAdapter === undefined ? {} : { getFinalityConfirmations: () => depthFromAdapter }),
    },
    inspectAndCommitContextGraphReadinessV1:
      RegisteredPrivateEmptyVmMethods.prototype.inspectAndCommitContextGraphReadinessV1,
    prepareContextGraphReadinessWithPrivateEmptyVmV1:
      RegisteredPrivateEmptyVmMethods.prototype.prepareContextGraphReadinessWithPrivateEmptyVmV1,
  } as unknown as DKGAgent;
  const commit = vi.fn();
  const preparation = await agent.prepareContextGraphReadinessWithPrivateEmptyVmV1({
    contextGraphId: CG, attemptPrivateEmptyVm: true, callerAgentAddress: CALLER,
  });
  const result = await preparation.inspectAndCommit({ inspectMetadata: true }, (completion) => {
    if (completion.proven) commit(completion.inspection);
    return completion;
  });
  return { server, result, commit };
}

describe('registered private zero-VM readiness finality', () => {
  it.each([
    ['adapter precedence', { getFinalityConfirmations: () => 12 }, { finalityConfirmations: 3 }, 12],
    ['configuration fallback', { getFinalityConfirmations: () => undefined }, { finalityConfirmations: 7 }, 7],
    ['unspecified depth', {}, undefined, undefined],
  ] as const)('uses the shared %s policy', (_label, chain, config, expected) => {
    expect(resolveChainFinalityConfirmationsV1(chain, config)).toBe(expected);
  });
  it.each([
    ['adapter depth', 12, 3, '0x8b'],
    ['chain config fallback', undefined, 7, '0x90'],
  ] as const)('pins the real proof at the %s anchor before committing', async (
    _label, adapterDepth, configDepth, anchor,
  ) => {
    const { server, result, commit } = await proveAtDepth(adapterDepth, configDepth);
    expect(result).toMatchObject({ proven: true });
    expect(commit).toHaveBeenCalledOnce();
    const headerReads = server.calls.filter((call) => call.method === 'eth_getBlockByNumber');
    expect(headerReads[0]?.params[0]).toBe('latest');
    expect(headerReads.slice(1).map((call) => call.params[0])).toContain(anchor);
    const proofReads = server.calls.filter((call) => {
      if (call.method !== 'eth_call') return false;
      return (call.params[0] as { data?: string }).data !== '0x';
    });
    expect(proofReads.length).toBeGreaterThan(0);
    expect(proofReads.map((call) => call.params[1])).toEqual(
      Array.from({ length: proofReads.length }, () => ({ blockHash: BLOCK_HASH, requireCanonical: true })),
    );
  });

  it('proves with the adapter chain ID when chainConfig omits chainId', async () => {
    const { result, commit } = await proveAtDepth(1, undefined, true);
    expect(result).toMatchObject({ proven: true });
    expect(commit).toHaveBeenCalledOnce();
  });
});

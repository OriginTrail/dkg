// SPDX-License-Identifier: Apache-2.0

/**
 * The adapter's own views over the batching seam: the same public reads, with
 * the number of physical requests they cost counted at the transport.
 */

import { Contract, ethers } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';

import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MULTICALL3_ADDRESS } from '../src/evm-background-read-batching.js';
import type { ReadOpts, RpcReadDescriptor } from '../src/rpc-failover-client.js';
import { withRpcRequestContext } from '../src/rpc-request-transport.js';
import { MULTICALL3_RUNTIME_CODE } from './fixtures/multicall3-runtime-code.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KAS = `0x${'a1'.repeat(20)}`;
const CG_STORAGE = `0x${'c9'.repeat(20)}`;
const PUBLISHER = ethers.getAddress(`0x${'b0'.repeat(20)}`);

const kasInterface = new ethers.Interface(loadAbi('DKGKnowledgeAssets'));
const cgInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));

const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });
const background = <T>(fn: () => T): T => withRpcRequestContext({ requestClass: 'background' }, fn);
const rootOf = (kaId: bigint) => ethers.zeroPadValue(ethers.toBeHex(kaId), 32);

/** The fake chain's answer to one view call. */
function chainAnswer(target: string, callData: string): string {
  const contractInterface = target.toLowerCase() === KAS ? kasInterface : cgInterface;
  const fragment = contractInterface.getFunction(callData.slice(0, 10))!;
  const args = contractInterface.decodeFunctionData(fragment, callData);
  const values: Record<string, readonly unknown[]> = {
    getLatestMerkleRoot: [rootOf(args[0] as bigint)],
    getLatestMerkleRootPublisher: [PUBLISHER],
    getKnowledgeAssetUpdateContext: [3n, 1n, 4_096n, 12n, 500n, false, 17],
    kaToContextGraph: [42n],
    getContextGraphKaAt: [1_000n + (args.length > 1 ? args[1] as bigint : 0n)],
    getContextGraphKaCount: [10n],
  };
  return contractInterface.encodeFunctionResult(fragment, values[fragment.name]!);
}

function makeAdapter() {
  const adapter = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    allowNoAdminSigner: true,
  } as EVMAdapterConfig);
  /** The label of every physical request, in order. */
  const requests: string[] = [];
  /** The read policy each contract read was issued with, by label. */
  const policies = new Map<string, ReadOpts['policy']>();
  const internals = adapter as unknown as {
    init(): Promise<void>;
    contracts: { knowledgeAssetStorage?: Contract; contextGraphStorage?: Contract };
    readProvider(label: string, fn: (provider: unknown) => Promise<unknown>): Promise<unknown>;
    rpcFailover: {
      readContract(
        descriptor: RpcReadDescriptor,
        contract: Contract,
        fn: (contract: unknown) => Promise<unknown>,
        opts?: ReadOpts,
      ): Promise<unknown>;
    };
  };
  internals.init = async () => undefined;
  internals.contracts.knowledgeAssetStorage = new Contract(KAS, loadAbi('DKGKnowledgeAssets'));
  internals.contracts.contextGraphStorage = new Contract(CG_STORAGE, loadAbi('ContextGraphStorage'));
  internals.readProvider = async (label, fn) => {
    requests.push(label);
    return fn({ getCode: async () => MULTICALL3_RUNTIME_CODE });
  };
  internals.rpcFailover.readContract = async (descriptor, contract, fn, opts) => {
    requests.push(descriptor.label);
    policies.set(descriptor.label, opts?.policy);
    if (contract.target === MULTICALL3_ADDRESS) {
      return fn({
        aggregate3: {
          staticCall: async (calls: Array<{ target: string; callData: string }>) => calls.map(
            ({ target, callData }) => ({ success: true, returnData: chainAnswer(target, callData) }),
          ),
        },
      });
    }
    // A single view: what the contract method call returns for the same answer.
    return fn(new Proxy({}, {
      get: (_target, method: string) => async (...args: unknown[]) => {
        const result = contract.interface.decodeFunctionResult(
          method,
          chainAnswer(contract.target as string, contract.interface.encodeFunctionData(method, args)),
        );
        return result.length === 1 ? result[0] : result;
      },
    }));
  };
  return { adapter, requests, policies };
}

/** An adapter whose Multicall3 bytecode check has passed. */
async function checkedAdapter() {
  const made = makeAdapter();
  await background(() => made.adapter.getLatestMerkleRoot(1n));
  await turn();
  made.requests.length = 0;
  return made;
}

afterEach(() => { delete process.env.DKG_DISABLE_RPC_READ_BATCHING; });

describe('adapter views in the background request class', () => {
  it('sends the first read directly while the bytecode check runs', async () => {
    const { adapter, requests } = makeAdapter();

    const root = await background(() => adapter.getLatestMerkleRoot(9n));

    expect(ethers.hexlify(root)).toBe(rootOf(9n));
    expect(requests).toEqual(['multicall3.getCode', 'kas.getLatestMerkleRoot']);
  });

  it('answers the three reads that authenticate an asset from one request', async () => {
    const { adapter, requests } = await checkedAdapter();

    const [root, rootCount, contextGraphId] = await background(() => Promise.all([
      adapter.getLatestMerkleRoot(7n),
      adapter.getMerkleRootCount(7n),
      adapter.getKAContextGraphId(7n),
    ]));

    expect(ethers.hexlify(root)).toBe(rootOf(7n));
    expect(rootCount).toBe(3n);
    expect(contextGraphId).toBe(42n);
    expect(requests).toEqual(['multicall3.aggregate3']);
  });

  it('caps the aggregate request on every node, and leaves a direct view as it was', async () => {
    const { adapter, policies } = await checkedAdapter();

    await background(() => adapter.getLatestMerkleRoot(7n));
    await adapter.getLatestMerkleRoot(7n);

    expect(policies.get('multicall3.aggregate3')).toBe('watchdogPointRead');
    expect(policies.get('kas.getLatestMerkleRoot')).toBeUndefined();
  });

  it('answers a pass worth of positions and sizing reads from one request', async () => {
    const { adapter, requests } = await checkedAdapter();
    const ordinals = Array.from({ length: 10 }, (_unused, index) => BigInt(index));

    const [kaIds, contexts, count, publisher] = await background(() => Promise.all([
      Promise.all(ordinals.map((ordinal) => adapter.getContextGraphKCAt(42n, ordinal))),
      Promise.all(ordinals.map((ordinal) => adapter.getKnowledgeAssetUpdateContext(1_000n + ordinal))),
      adapter.getContextGraphKCCount(42n),
      adapter.getLatestMerkleRootPublisher(1_000n),
    ]));

    expect(kaIds).toEqual(ordinals.map((ordinal) => 1_000n + ordinal));
    expect(contexts[0]).toMatchObject({ merkleRootsCount: 3n, byteSize: 4_096n, merkleLeafCount: 17 });
    expect(count).toBe(10n);
    expect(publisher).toBe(PUBLISHER);
    expect(requests).toEqual(['multicall3.aggregate3']);
  });

  it('returns the same values as the same reads issued in the foreground', async () => {
    const { adapter, requests } = await checkedAdapter();
    const read = () => Promise.all([
      adapter.getLatestMerkleRoot(5n),
      adapter.getMerkleRootCount(5n),
      adapter.getKnowledgeAssetUpdateContext(5n),
      adapter.getKAContextGraphId(5n),
      adapter.getContextGraphKCAt(42n, 3n),
      adapter.getLatestMerkleRootPublisher(5n),
    ]);

    const foreground = await read();
    const foregroundRequests = requests.splice(0);
    const batched = await background(read);

    expect(batched).toEqual(foreground);
    // One request per read in the foreground, as before; one for all in the background.
    expect(foregroundRequests.sort()).toEqual([
      'cgStorage.getContextGraphKaAt',
      'cgStorage.kaToContextGraph',
      'kas.getKnowledgeAssetUpdateContext',
      'kas.getKnowledgeAssetUpdateContext',
      'kas.getLatestMerkleRoot',
      'kas.getLatestMerkleRootPublisher',
    ]);
    expect(requests).toEqual(['multicall3.aggregate3']);
  });

  it('issues every read directly when the kill switch is set', async () => {
    const { adapter, requests } = await checkedAdapter();
    process.env.DKG_DISABLE_RPC_READ_BATCHING = '1';

    await background(() => Promise.all([adapter.getLatestMerkleRoot(1n), adapter.getKAContextGraphId(1n)]));

    expect(requests).toEqual(['kas.getLatestMerkleRoot', 'cgStorage.kaToContextGraph']);
  });
});

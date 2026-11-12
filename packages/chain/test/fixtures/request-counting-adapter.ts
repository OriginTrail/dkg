// SPDX-License-Identifier: Apache-2.0

/**
 * The real EVM adapter over a transport double that answers its views and
 * counts the physical requests they cost. The adapter internals it replaces
 * are described here only, for every suite that counts what its reads cost.
 */

import { Contract, ethers } from 'ethers';

import { EVMChainAdapter, type EVMAdapterConfig } from '../../src/evm-adapter.js';
import { loadAbi } from '../../src/evm-adapter-abi.js';
import { MULTICALL3_ADDRESS } from '../../src/evm-background-read-batching.js';
import type { ReadOpts, RpcReadDescriptorInput } from '../../src/rpc-failover-client.js';
import { withRpcRequestContext } from '../../src/rpc-request-transport.js';
import { MULTICALL3_RUNTIME_CODE } from './multicall3-runtime-code.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KAS = `0x${'a1'.repeat(20)}`;
const CG_STORAGE = `0x${'c9'.repeat(20)}`;
/** The publisher the fake chain answers for every asset. */
export const PUBLISHER = ethers.getAddress(`0x${'b0'.repeat(20)}`);

const kasInterface = new ethers.Interface(loadAbi('DKGKnowledgeAssets'));
const cgInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));

const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });
/** Runs `fn` in the background request class, whose views the adapter batches. */
export const background = <T>(fn: () => T): T => withRpcRequestContext({ requestClass: 'background' }, fn);
/** The latest Merkle root the fake chain answers for an asset: its id, as 32 bytes. */
export const rootOf = (kaId: bigint) => ethers.zeroPadValue(ethers.toBeHex(kaId), 32);

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

export function makeAdapter() {
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
        descriptor: RpcReadDescriptorInput,
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
    // The client accepts labels for adapter views and explicit descriptors for
    // batched calls. This transport double records either public input form.
    const label = typeof descriptor === 'string' ? descriptor : descriptor.label;
    requests.push(label);
    policies.set(label, opts?.policy);
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
export async function checkedAdapter() {
  const made = makeAdapter();
  await background(() => made.adapter.getLatestMerkleRoot(1n));
  await turn();
  made.requests.length = 0;
  return made;
}

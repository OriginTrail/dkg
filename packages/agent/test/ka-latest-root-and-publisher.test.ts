// SPDX-License-Identifier: Apache-2.0

/**
 * A Knowledge Asset's latest root and its publisher are read together.
 *
 * Background views issued in the same turn leave the EVM adapter as one
 * Multicall3 request. The VM reconcile pass and the ACK promotion lanes read
 * the root and then the publisher, so each pair cost two requests, and an
 * ordinal that stays pending reads the pair again on every sweep.
 * Pure: stub adapters, and the real EVM adapter over a transport double that
 * counts physical requests. No hardhat.
 */

import { Contract, ethers } from 'ethers';
import { EVMChainAdapter, withRpcRequestContext } from '@origintrail-official/dkg-chain';
import { describe, expect, it } from 'vitest';
import { readLatestMerkleRootAndPublisher } from '../src/ka-latest-root-and-publisher.js';
import { MULTICALL3_RUNTIME_CODE } from '../../chain/test/fixtures/multicall3-runtime-code.js';

const ROOT = ethers.getBytes(`0x${'a7'.repeat(32)}`);
const PUBLISHER = ethers.getAddress(`0x${'b0'.repeat(20)}`);
const KAS = `0x${'a1'.repeat(20)}`;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A chain whose two reads answer only when the test says so. */
function heldChain() {
  const root = deferred<Uint8Array>();
  const publisher = deferred<string>();
  const asked: string[] = [];
  return {
    root,
    publisher,
    asked,
    chain: {
      getLatestMerkleRoot: (kaId: bigint) => { asked.push(`root:${kaId}`); return root.promise; },
      getLatestMerkleRootPublisher: (kaId: bigint) => { asked.push(`publisher:${kaId}`); return publisher.promise; },
    },
  };
}

const KAS_ABI = [
  'function getLatestMerkleRoot(uint256 id) view returns (bytes32)',
  'function getLatestMerkleRootPublisher(uint256 id) view returns (address)',
];
const kasInterface = new ethers.Interface(KAS_ABI);

/** The fake chain's answer to one view call. */
function chainAnswer(callData: string): string {
  const fragment = kasInterface.getFunction(callData.slice(0, 10))!;
  return kasInterface.encodeFunctionResult(
    fragment,
    fragment.name === 'getLatestMerkleRoot' ? [ethers.hexlify(ROOT)] : [PUBLISHER],
  );
}

/** The real adapter, its Multicall3 check passed, with every physical request's label recorded. */
async function countingAdapter() {
  const adapter = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    allowNoAdminSigner: true,
  } as ConstructorParameters<typeof EVMChainAdapter>[0]);
  const requests: string[] = [];
  const internals = adapter as unknown as {
    init(): Promise<void>;
    contracts: { knowledgeAssetStorage?: Contract };
    readProvider(label: string, fn: (provider: unknown) => Promise<unknown>): Promise<unknown>;
    rpcFailover: {
      readContract(
        descriptor: string | { label: string },
        contract: Contract,
        fn: (contract: unknown) => Promise<unknown>,
      ): Promise<unknown>;
    };
  };
  internals.init = async () => undefined;
  internals.contracts.knowledgeAssetStorage = new Contract(KAS, KAS_ABI);
  internals.readProvider = async (label, fn) => {
    requests.push(label);
    return fn({ getCode: async () => MULTICALL3_RUNTIME_CODE });
  };
  internals.rpcFailover.readContract = async (descriptor, contract, fn) => {
    const label = typeof descriptor === 'string' ? descriptor : descriptor.label;
    requests.push(label);
    if (label === 'multicall3.aggregate3') {
      return fn({
        aggregate3: {
          staticCall: async (calls: Array<{ callData: string }>) => calls.map(
            ({ callData }) => ({ success: true, returnData: chainAnswer(callData) }),
          ),
        },
      });
    }
    return fn(new Proxy({}, {
      get: (_target, method: string) => async (...args: unknown[]) => contract.interface
        .decodeFunctionResult(method, chainAnswer(contract.interface.encodeFunctionData(method, args)))[0],
    }));
  };
  const background = <T>(fn: () => Promise<T>): Promise<T> => withRpcRequestContext({ requestClass: 'background' }, fn);
  // The first background read runs the bytecode check; batching starts after it.
  await background(() => adapter.getLatestMerkleRoot(1n));
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  requests.length = 0;
  return { adapter, requests, background };
}

describe('readLatestMerkleRootAndPublisher', () => {
  it('asks for both views before either answers', async () => {
    const held = heldChain();

    const read = readLatestMerkleRootAndPublisher(held.chain, 7n);
    expect(held.asked).toEqual(['root:7', 'publisher:7']);

    held.publisher.resolve(PUBLISHER);
    held.root.resolve(ROOT);
    await expect(read).resolves.toEqual({ merkleRoot: ROOT, publisherAddress: PUBLISHER });
  });

  it('reports the root\'s failure first, as when the publisher was read after it', async () => {
    const held = heldChain();
    const read = readLatestMerkleRootAndPublisher(held.chain, 7n);
    held.publisher.reject(new Error('publisher read failed'));
    held.root.reject(new Error('root read failed'));
    await expect(read).rejects.toThrow('root read failed');
  });

  it('reports the publisher\'s failure when the root was read', async () => {
    const held = heldChain();
    const read = readLatestMerkleRootAndPublisher(held.chain, 7n);
    held.root.resolve(ROOT);
    held.publisher.reject(new Error('publisher read failed'));
    await expect(read).rejects.toThrow('publisher read failed');
  });

  it('takes no publisher as an empty address, as the callers always did', async () => {
    await expect(readLatestMerkleRootAndPublisher({ getLatestMerkleRoot: async () => ROOT }, 7n))
      .resolves.toEqual({ merkleRoot: ROOT, publisherAddress: '' });
    await expect(readLatestMerkleRootAndPublisher({
      getLatestMerkleRoot: async () => ROOT,
      getLatestMerkleRootPublisher: async () => undefined as unknown as string,
    }, 7n)).resolves.toEqual({ merkleRoot: ROOT, publisherAddress: '' });
  });

  it('costs one request through the adapter\'s background batching, where one read after the other costs two', async () => {
    const { adapter, requests, background } = await countingAdapter();

    const together = await background(() => readLatestMerkleRootAndPublisher(adapter, 7n));
    expect(together).toEqual({ merkleRoot: ROOT, publisherAddress: PUBLISHER });
    expect(requests).toEqual(['multicall3.aggregate3']);

    requests.length = 0;
    await background(async () => {
      await adapter.getLatestMerkleRoot(7n);
      await adapter.getLatestMerkleRootPublisher(7n);
    });
    expect(requests).toEqual(['multicall3.aggregate3', 'multicall3.aggregate3']);
  });
});

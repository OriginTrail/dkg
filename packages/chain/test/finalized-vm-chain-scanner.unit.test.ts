import {
  type BlockNumberV1,
  type ChainIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';

import { loadAbi } from '../src/evm-adapter-abi.js';
import {
  FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1,
  snapshotFinalizedVmChainInventoryV1,
} from '../src/finalized-vm-chain-inventory.js';
import {
  createFinalizedVmChainScannerV1,
  scanFinalizedVmChainInventoryInSnapshotV1,
} from '../src/finalized-vm-chain-scanner.js';
import {
  CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1,
  CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CALLS_V1,
  type StrictCurrentFinalizedEvmSnapshotScopeV1,
  type StrictCurrentFinalizedEvmSnapshotSessionV1,
} from '../src/current-finalized-evm-snapshot.js';
import { CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1 } from '../src/current-finalized-evm-read-profile.js';
import { createStrictCurrentFinalizedEvmSnapshotScopeV1 } from '../src/strict-current-finalized-evm-snapshot-factory.js';
import {
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcError as sendError,
  sendJsonRpcResult as sendResult,
} from './loopback-rpc-harness.js';

const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CHAIN_ID = '20430' as ChainIdV1;
const CG_STORAGE = `0x${'11'.repeat(20)}` as EvmAddressV1;
const KA_STORAGE = `0x${'22'.repeat(20)}` as EvmAddressV1;
const AUTHOR_A = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as EvmAddressV1;
const AUTHOR_B = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as EvmAddressV1;
const PUBLISHER_A = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const PUBLISHER_B = '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const ROOT_A = `0x${'aa'.repeat(32)}` as Digest32V1;
const ROOT_B = `0x${'bb'.repeat(32)}` as Digest32V1;
const BLOCK_HASH = `0x${'44'.repeat(32)}` as Digest32V1;
const BLOCK_NUMBER = '123' as BlockNumberV1;
const CG_ID = '14' as const;
const CG_ABI = new ethers.Interface(loadAbi('ContextGraphStorage'));
const KA_ABI = new ethers.Interface(loadAbi('DKGKnowledgeAssets'));
const ABI = ethers.AbiCoder.defaultAbiCoder();
const KA_A = pack(AUTHOR_A, 7n);
const KA_B = pack(AUTHOR_B, 9n);

const rpcHarness = createLoopbackJsonRpcTestHarness();

afterEach(async () => {
  await rpcHarness.stopAll();
});

describe('RFC-64 finalized VM chain scanner', () => {
  it('executes its exported row ceiling within both snapshot resource budgets', async () => {
    let batches = 0;
    let calls = 0;
    const snapshot = snapshotStub(async (batch) => {
      batches += 1;
      calls += batch.length;
      return batch.map(({ data }) => {
        const selector = data.slice(0, 10);
        if (selector === CG_ABI.getFunction('isContextGraphActive')!.selector) {
          return boolResult(true);
        }
        if (selector === CG_ABI.getFunction('getContextGraphKaCount')!.selector) {
          return uintResult(BigInt(FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1));
        }
        if (selector === CG_ABI.getFunction('getContextGraphKaAt')!.selector) {
          const [, ordinal] = CG_ABI.decodeFunctionData('getContextGraphKaAt', data);
          return uintResult(pack(AUTHOR_A, BigInt(ordinal) + 1n));
        }
        if (selector === KA_ABI.getFunction('getKnowledgeAssetUpdateContext')!.selector) {
          return updateContextResult(1n);
        }
        if (selector === KA_ABI.getFunction('getLatestMerkleRoot')!.selector) {
          return bytes32Result(ROOT_A);
        }
        if (selector === KA_ABI.getFunction('getLatestMerkleRootAuthor')!.selector) {
          return addressResult(AUTHOR_A);
        }
        if (selector === KA_ABI.getFunction('getLatestMerkleRootPublisher')!.selector) {
          return addressResult(PUBLISHER_A);
        }
        throw new Error(`Unexpected selector ${selector}`);
      });
    });
    const scanner = createFinalizedVmChainScannerV1(config(snapshot));

    const inventory = await scanner({
      contextGraphId: CG_ID,
      signal: new AbortController().signal,
    });

    expect(inventory.rows).toHaveLength(FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1);
    expect(inventory.rows.at(-1)?.ordinal)
      .toBe(String(FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1 - 1));
    expect(calls).toBe(2 + (FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1 * 5));
    expect(batches).toBe(
      1
      + Math.ceil(FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1 / CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1)
      + FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1,
    );
    expect(calls).toBeLessThanOrEqual(CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CALLS_V1);
    expect(batches).toBeLessThanOrEqual(CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1);
  });

  it('derives ordered rootless VM candidates from one pinned snapshot', async () => {
    const calls: Array<readonly { readonly to: string; readonly data: string }[]> = [];
    const snapshot = snapshotStub(async (batch) => {
      calls.push(batch);
      if (calls.length === 1) return [boolResult(true), uintResult(2n)];
      if (calls.length === 2) return [uintResult(KA_A), uintResult(KA_B)];
      if (calls.length === 3) return [
        updateContextResult(2n),
        bytes32Result(ROOT_A),
        addressResult(AUTHOR_A),
        addressResult(PUBLISHER_A),
      ];
      return [
        updateContextResult(3n),
        bytes32Result(ROOT_B),
        addressResult(AUTHOR_B),
        addressResult(PUBLISHER_B),
      ];
    });
    const scanner = createFinalizedVmChainScannerV1(config(snapshot));
    const requestSignal = new AbortController().signal;

    const inventory = await scanner({ contextGraphId: CG_ID, signal: requestSignal });

    expect(Object.isFrozen(scanner)).toBe(true);
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.rows)).toBe(true);
    expect(snapshotFinalizedVmChainInventoryV1(structuredClone(inventory))).toEqual(inventory);
    expect(() => snapshotFinalizedVmChainInventoryV1({
      ...structuredClone(inventory),
      unexpected: true,
    })).toThrow(/not canonical/);
    expect(inventory).toEqual({
      networkId: NETWORK_ID,
      contextGraphId: CG_ID,
      chainId: CHAIN_ID,
      contractAddress: CG_STORAGE,
      knowledgeAssetStorageAddress: KA_STORAGE,
      finalizedBlockNumber: BLOCK_NUMBER,
      finalizedBlockHash: BLOCK_HASH,
      highestFinalizedOrdinal: '1',
      rows: [
        {
          chainId: CHAIN_ID,
          contractAddress: CG_STORAGE,
          knowledgeAssetStorageAddress: KA_STORAGE,
          ordinal: '0',
          kaId: KA_A.toString(),
          ual: `did:dkg:${NETWORK_ID}/${AUTHOR_A}/7`,
          authorAddress: AUTHOR_A,
          attestedAuthorAddress: AUTHOR_A,
          publisherAddress: PUBLISHER_A,
          assertionVersion: '2',
          assertionRoot: ROOT_A,
          finalizedBlockNumber: BLOCK_NUMBER,
          finalizedBlockHash: BLOCK_HASH,
        },
        {
          chainId: CHAIN_ID,
          contractAddress: CG_STORAGE,
          knowledgeAssetStorageAddress: KA_STORAGE,
          ordinal: '1',
          kaId: KA_B.toString(),
          ual: `did:dkg:${NETWORK_ID}/${AUTHOR_B}/9`,
          authorAddress: AUTHOR_B,
          attestedAuthorAddress: AUTHOR_B,
          publisherAddress: PUBLISHER_B,
          assertionVersion: '3',
          assertionRoot: ROOT_B,
          finalizedBlockNumber: BLOCK_NUMBER,
          finalizedBlockHash: BLOCK_HASH,
        },
      ],
    });
    expect(calls.map((batch) => batch.length)).toEqual([2, 2, 4, 4]);
    expect(calls[0]![0]!.to).toBe(CG_STORAGE);
    expect(calls[1]!.every(({ to }) => to === CG_STORAGE)).toBe(true);
    expect(calls.slice(2).flat().every(({ to }) => to === KA_STORAGE)).toBe(true);
  });

  it('returns a canonical empty inventory without issuing ordinal reads', async () => {
    let batches = 0;
    const requestSignal = new AbortController().signal;
    const scanner = createFinalizedVmChainScannerV1(config(snapshotStub(async () => {
      batches += 1;
      return [boolResult(true), uintResult(0n)];
    }, requestSignal)));

    await expect(scanner({
      contextGraphId: CG_ID,
      signal: requestSignal,
    })).resolves.toMatchObject({
      highestFinalizedOrdinal: null,
      rows: [],
    });
    expect(batches).toBe(1);
  });

  it('fails closed when the pinned context graph is inactive', async () => {
    const scanner = createFinalizedVmChainScannerV1(config(scriptedSnapshot([
      [boolResult(false), uintResult(0n)],
    ])));
    await expect(scanner({
      contextGraphId: CG_ID,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'malformed-return' });
  });

  it('splits five rows into bounded ordered ID and assertion batches', async () => {
    const batchSizes: number[] = [];
    const kaIds = Array.from({ length: 5 }, (_, index) => pack(AUTHOR_A, BigInt(index + 1)));
    const snapshot = snapshotStub(async (batch) => {
      batchSizes.push(batch.length);
      return batch.map(({ data }) => {
        const selector = data.slice(0, 10);
        if (selector === CG_ABI.getFunction('isContextGraphActive')!.selector) {
          return boolResult(true);
        }
        if (selector === CG_ABI.getFunction('getContextGraphKaCount')!.selector) {
          return uintResult(5n);
        }
        if (selector === CG_ABI.getFunction('getContextGraphKaAt')!.selector) {
          const [, ordinal] = CG_ABI.decodeFunctionData('getContextGraphKaAt', data);
          return uintResult(kaIds[Number(ordinal)]!);
        }
        if (selector === KA_ABI.getFunction('getKnowledgeAssetUpdateContext')!.selector) {
          return updateContextResult(1n);
        }
        if (selector === KA_ABI.getFunction('getLatestMerkleRoot')!.selector) {
          return bytes32Result(ROOT_A);
        }
        if (selector === KA_ABI.getFunction('getLatestMerkleRootAuthor')!.selector) {
          return addressResult(AUTHOR_A);
        }
        if (selector === KA_ABI.getFunction('getLatestMerkleRootPublisher')!.selector) {
          return addressResult(PUBLISHER_A);
        }
        throw new Error(`Unexpected selector ${selector}`);
      });
    });
    const scanner = createFinalizedVmChainScannerV1(config(snapshot));

    const inventory = await scanner({
      contextGraphId: CG_ID,
      signal: new AbortController().signal,
    });

    expect(batchSizes).toEqual([2, 4, 1, 4, 4, 4, 4, 4]);
    expect(batchSizes.every((size) => size <= CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1))
      .toBe(true);
    expect(inventory.rows.map(({ kaId, ual }) => ({ kaId, ual }))).toEqual(
      kaIds.map((kaId, index) => ({
        kaId: kaId.toString(),
        ual: `did:dkg:${NETWORK_ID}/${AUTHOR_A}/${index + 1}`,
      })),
    );
  });

  it('fails before ordinal reads when the finalized inventory exceeds the v1 scope', async () => {
    let batches = 0;
    const scanner = createFinalizedVmChainScannerV1(config(snapshotStub(async () => {
      batches += 1;
      return [
        boolResult(true),
        uintResult(BigInt(FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1 + 1)),
      ];
    })));

    await expect(scanner({
      contextGraphId: CG_ID,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'resource-limit' });
    expect(batches).toBe(1);
  });

  it('rejects legacy sequential ids, zero versions, zero roots, and batch shape drift', async () => {
    const cases: StrictCurrentFinalizedEvmSnapshotScopeV1[] = [
      scriptedSnapshot([activeCountResults(1n), [uintResult(7n)], assertionResults(1n, ROOT_A, AUTHOR_A, PUBLISHER_A)]),
      scriptedSnapshot([activeCountResults(1n), [uintResult(KA_A)], assertionResults(0n, ROOT_A, AUTHOR_A, PUBLISHER_A)]),
      scriptedSnapshot([activeCountResults(1n), [uintResult(KA_A)], assertionResults(1n, ethers.ZeroHash, AUTHOR_A, PUBLISHER_A)]),
      scriptedSnapshot([activeCountResults(1n), []]),
    ];
    for (const snapshot of cases) {
      const scanner = createFinalizedVmChainScannerV1(config(snapshot));
      await expect(scanner({
        contextGraphId: CG_ID,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'malformed-return' });
    }
  });

  it('keeps absent evidence explicit and preserves transferred KA namespace separately', async () => {
    const noEvidence = createFinalizedVmChainScannerV1(config(scriptedSnapshot([
      activeCountResults(1n),
      [uintResult(KA_A)],
      assertionResults(1n, ROOT_A, ethers.ZeroAddress, ethers.ZeroAddress),
    ])));
    await expect(noEvidence({
      contextGraphId: CG_ID,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      rows: [{ attestedAuthorAddress: null, publisherAddress: null }],
    });

    const transferredUpdate = createFinalizedVmChainScannerV1(config(scriptedSnapshot([
      activeCountResults(1n),
      [uintResult(KA_A)],
      assertionResults(1n, ROOT_A, AUTHOR_B, PUBLISHER_A),
    ])));
    await expect(transferredUpdate({
      contextGraphId: CG_ID,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      rows: [{
        kaId: KA_A.toString(),
        ual: `did:dkg:${NETWORK_ID}/${AUTHOR_A}/7`,
        authorAddress: AUTHOR_A,
        attestedAuthorAddress: AUTHOR_B,
      }],
    });
  });

  it('scans inside a caller-owned snapshot session for same-anchor runtime composition', async () => {
    const session = Object.freeze({
      chainId: CHAIN_ID,
      blockNumber: BLOCK_NUMBER,
      blockHash: BLOCK_HASH,
      read: scriptedRead([
        activeCountResults(1n),
        [uintResult(KA_A)],
        assertionResults(2n, ROOT_A, AUTHOR_A, PUBLISHER_A),
      ]),
    }) satisfies StrictCurrentFinalizedEvmSnapshotSessionV1;

    const inventory = await scanFinalizedVmChainInventoryInSnapshotV1(
      sessionConfig(),
      { contextGraphId: CG_ID, signal: new AbortController().signal },
      session,
    );

    expect(inventory.rows).toHaveLength(1);
    expect(inventory.rows[0]).toMatchObject({
      attestedAuthorAddress: AUTHOR_A,
      publisherAddress: PUBLISHER_A,
      finalizedBlockHash: BLOCK_HASH,
    });
  });

  it('rejects a decodable non-canonical ABI result at the assertion decoder', async () => {
    let batches = 0;
    const nonCanonicalRoot = `${bytes32Result(ROOT_A).slice(0, 2)}${bytes32Result(ROOT_A).slice(2).toUpperCase()}`;
    const scanner = createFinalizedVmChainScannerV1(config(snapshotStub(async () => {
      batches += 1;
      if (batches === 1) return activeCountResults(1n);
      if (batches === 2) return [uintResult(KA_A)];
      return [
        updateContextResult(2n),
        nonCanonicalRoot,
        addressResult(AUTHOR_A),
        addressResult(PUBLISHER_A),
      ];
    })));

    await expect(scanner({
      contextGraphId: CG_ID,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'malformed-return' });
    expect(batches).toBe(3);
  });

  it('rejects incomplete batch shapes and hostile local inputs', async () => {
    const malformed = createFinalizedVmChainScannerV1(config(snapshotStub(async () => [
      uintResult(0n),
    ])));
    await expect(malformed({
      contextGraphId: CG_ID,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'malformed-return' });

    expect(() => createFinalizedVmChainScannerV1({
      ...config(snapshotStub(async () => [uintResult(0n)])),
      contextGraphStorageAddress: CG_STORAGE.toUpperCase() as EvmAddressV1,
    })).toThrow(TypeError);
    await expect(malformed({
      contextGraphId: '0' as never,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'rpc-unavailable' });
    await expect(malformed({
      contextGraphId: '014' as never,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'rpc-unavailable' });
    await expect(malformed({
      contextGraphId: CG_ID,
      signal: {} as never,
    })).rejects.toMatchObject({ code: 'rpc-unavailable' });
  });

  it('executes the complete scan over the real strict loopback transport', async () => {
    const rpc = await rpcHarness.start((call, response) => {
      switch (call.method) {
        case 'eth_chainId':
          sendResult(response, call, '0x4fce');
          return;
        case 'eth_getBlockByNumber':
          sendResult(response, call, { number: '0x7b', hash: BLOCK_HASH });
          return;
        case 'eth_getCode':
          sendResult(response, call, '0x6000');
          return;
        case 'eth_call': {
          const request = call.params[0] as { readonly data?: string };
          const data = request.data ?? '';
          const selector = data.slice(0, 10);
          if (data === '0x') {
            sendResult(response, call, '0x');
          } else if (selector === CG_ABI.getFunction('isContextGraphActive')!.selector) {
            sendResult(response, call, boolResult(true));
          } else if (selector === CG_ABI.getFunction('getContextGraphKaCount')!.selector) {
            sendResult(response, call, uintResult(2n));
          } else if (selector === CG_ABI.getFunction('getContextGraphKaAt')!.selector) {
            const [, ordinal] = CG_ABI.decodeFunctionData('getContextGraphKaAt', data);
            sendResult(response, call, uintResult(BigInt(ordinal) === 0n ? KA_A : KA_B));
          } else if (selector === KA_ABI.getFunction('getKnowledgeAssetUpdateContext')!.selector) {
            const [kaId] = KA_ABI.decodeFunctionData('getKnowledgeAssetUpdateContext', data);
            sendResult(response, call, updateContextResult(BigInt(kaId) === KA_A ? 2n : 3n));
          } else if (selector === KA_ABI.getFunction('getLatestMerkleRoot')!.selector) {
            const [kaId] = KA_ABI.decodeFunctionData('getLatestMerkleRoot', data);
            sendResult(response, call, bytes32Result(BigInt(kaId) === KA_A ? ROOT_A : ROOT_B));
          } else if (selector === KA_ABI.getFunction('getLatestMerkleRootAuthor')!.selector) {
            const [kaId] = KA_ABI.decodeFunctionData('getLatestMerkleRootAuthor', data);
            sendResult(response, call, addressResult(BigInt(kaId) === KA_A ? AUTHOR_A : AUTHOR_B));
          } else if (selector === KA_ABI.getFunction('getLatestMerkleRootPublisher')!.selector) {
            const [kaId] = KA_ABI.decodeFunctionData('getLatestMerkleRootPublisher', data);
            sendResult(response, call, addressResult(BigInt(kaId) === KA_A ? PUBLISHER_A : PUBLISHER_B));
          } else {
            sendError(response, call, -32601, 'unexpected eth_call selector');
          }
          return;
        }
        default:
          sendError(response, call, -32601, 'method not found');
      }
    });
    const snapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      chainId: CHAIN_ID,
      endpoints: [rpc.url],
    });
    const scanner = createFinalizedVmChainScannerV1(config(snapshot));

    const inventory = await scanner({
      contextGraphId: CG_ID,
      signal: new AbortController().signal,
    });

    expect(inventory.rows.map(({ ual, assertionVersion, assertionRoot }) => ({
      ual,
      assertionVersion,
      assertionRoot,
    }))).toEqual([
      { ual: `did:dkg:${NETWORK_ID}/${AUTHOR_A}/7`, assertionVersion: '2', assertionRoot: ROOT_A },
      { ual: `did:dkg:${NETWORK_ID}/${AUTHOR_B}/9`, assertionVersion: '3', assertionRoot: ROOT_B },
    ]);
    const ethCalls = rpc.calls.filter(({ method }) => method === 'eth_call');
    expect(ethCalls).toHaveLength(13);
    expect(ethCalls.every(({ params }) => {
      const block = params[1] as { readonly blockHash?: unknown; readonly requireCanonical?: unknown };
      return block.blockHash === BLOCK_HASH && block.requireCanonical === true;
    })).toBe(true);
  });
});

function config(snapshot: StrictCurrentFinalizedEvmSnapshotScopeV1) {
  return Object.freeze({
    ...sessionConfig(),
    snapshot,
  });
}

function sessionConfig() {
  return Object.freeze({
    networkId: NETWORK_ID,
    chainId: CHAIN_ID,
    contextGraphStorageAddress: CG_STORAGE,
    knowledgeAssetStorageAddress: KA_STORAGE,
  });
}

function snapshotStub(
  read: StrictCurrentFinalizedEvmSnapshotSessionV1['read'],
  expectedSignal?: AbortSignal,
): StrictCurrentFinalizedEvmSnapshotScopeV1 {
  return Object.freeze(async <T>(request: {
    readonly chainId: ChainIdV1;
    readonly signal: AbortSignal;
  }, consume: (
    session: StrictCurrentFinalizedEvmSnapshotSessionV1,
  ) => Promise<T>): Promise<T> => {
    expect(request.chainId).toBe(CHAIN_ID);
    if (expectedSignal !== undefined) expect(request.signal).toBe(expectedSignal);
    return consume(Object.freeze({
      chainId: CHAIN_ID,
      blockNumber: BLOCK_NUMBER,
      blockHash: BLOCK_HASH,
      read,
    }));
  });
}

function scriptedSnapshot(
  responses: readonly (readonly string[])[],
): StrictCurrentFinalizedEvmSnapshotScopeV1 {
  return snapshotStub(scriptedRead(responses));
}

function scriptedRead(
  responses: readonly (readonly string[])[],
): StrictCurrentFinalizedEvmSnapshotSessionV1['read'] {
  let index = 0;
  return async () => responses[index++] ?? [];
}

function pack(author: EvmAddressV1, number: bigint): bigint {
  return (BigInt(author) << 96n) | number;
}

function uintResult(value: bigint): string {
  return ABI.encode(['uint256'], [value]);
}

function boolResult(value: boolean): string {
  return ABI.encode(['bool'], [value]);
}

function activeCountResults(count: bigint): readonly string[] {
  return [boolResult(true), uintResult(count)];
}

function bytes32Result(value: string): string {
  return ABI.encode(['bytes32'], [value]);
}

function addressResult(value: string): string {
  return ABI.encode(['address'], [value]);
}

function assertionResults(
  version: bigint,
  root: string,
  author: string,
  publisher: string,
): readonly string[] {
  return [
    updateContextResult(version),
    bytes32Result(root),
    addressResult(author),
    addressResult(publisher),
  ];
}

function updateContextResult(version: bigint): string {
  return ABI.encode(
    ['uint256', 'uint256', 'uint88', 'uint40', 'uint96', 'bool', 'uint32'],
    [version, 1n, 100n, 999n, 1n, false, 3n],
  );
}

import { ethers } from 'ethers';
import type { DecimalU256V1, EvmAddressV1 } from '@origintrail-official/dkg-core';

import { CurrentFinalizedEvmCallErrorV1 } from './current-finalized-evm-read-profile.js';
import {
  FinalizedContextGraphReadErrorV1,
  type FinalizedContextGraphBindingV1,
  type FinalizedContextGraphReadResolverWithSignalV1,
  type UntrustedFinalizedContextGraphFieldsV1,
} from './finalized-context-graph-read.js';
import {
  readStrictCurrentFinalizedEvmRevertDataV1,
  type StrictCurrentFinalizedEvmReadResultV1,
  type StrictCurrentFinalizedEvmReadV1,
} from './strict-current-finalized-evm-rpc.js';
import type { StrictCurrentFinalizedEvmSnapshotSessionV1 } from './current-finalized-evm-snapshot.js';

// getContextGraph has nine fixed words plus a chain-capped 256-address array:
// its maximal canonical ABI result is 8,512 bytes, below this domain ceiling.
export const FINALIZED_CONTEXT_GRAPH_TUPLE_MAX_RETURN_BYTES_V1 = 9 * 1024;
export const FINALIZED_CONTEXT_GRAPH_NAME_HASH_MAX_RETURN_BYTES_V1 = 32;

const CONTEXT_GRAPH_STORAGE_FINALIZED_READ_INTERFACE = new ethers.Interface([
  'function getContextGraph(uint256 contextGraphId) view returns (address owner, address[] participantAgents, uint256 metadataBatchId, bool active, uint256 createdAt, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
  'function getNameHash(uint256 contextGraphId) view returns (bytes32)',
  'function getContextGraphKaCount(uint256 contextGraphId) view returns (uint256)',
]);
const HUB_STORAGE_FINALIZED_READ_INTERFACE = new ethers.Interface([
  'function getAssetStorageAddress(string assetStorageName) view returns (address)',
]);
const ERC721_FINALIZED_READ_ERROR_INTERFACE = new ethers.Interface([
  'error ERC721NonexistentToken(uint256 tokenId)',
]);

/** Chain-owned, canonical facts for the registered empty-VM readiness proof. */
export interface FinalizedContextGraphEmptyVmFactsV1 {
  readonly active: boolean;
  readonly accessPolicy: number;
  readonly nameHash: string;
  readonly participantAgents: readonly string[];
  readonly kaCount: bigint;
  readonly contextGraphStorageAddress: string;
}

/** Read all four proof facts at the caller's one pinned finalized anchor. */
export async function readFinalizedContextGraphEmptyVmFactsInSnapshotV1(input: {
  readonly contextGraphId: DecimalU256V1;
  readonly contextGraphStorageAddress: EvmAddressV1;
  readonly hubAddress: EvmAddressV1;
  readonly session: StrictCurrentFinalizedEvmSnapshotSessionV1;
}): Promise<FinalizedContextGraphEmptyVmFactsV1 | null> {
  const id = BigInt(input.contextGraphId);
  const encoded = await input.session.read([
    {
      to: input.contextGraphStorageAddress,
      data: CONTEXT_GRAPH_STORAGE_FINALIZED_READ_INTERFACE.encodeFunctionData('getContextGraph', [id]),
      maxReturnBytes: FINALIZED_CONTEXT_GRAPH_TUPLE_MAX_RETURN_BYTES_V1,
    },
    {
      to: input.contextGraphStorageAddress,
      data: CONTEXT_GRAPH_STORAGE_FINALIZED_READ_INTERFACE.encodeFunctionData('getNameHash', [id]),
      maxReturnBytes: FINALIZED_CONTEXT_GRAPH_NAME_HASH_MAX_RETURN_BYTES_V1,
    },
    {
      to: input.contextGraphStorageAddress,
      data: CONTEXT_GRAPH_STORAGE_FINALIZED_READ_INTERFACE.encodeFunctionData('getContextGraphKaCount', [id]),
      maxReturnBytes: 32,
    },
    {
      to: input.hubAddress,
      data: HUB_STORAGE_FINALIZED_READ_INTERFACE.encodeFunctionData('getAssetStorageAddress', ['ContextGraphStorage']),
      maxReturnBytes: 32,
    },
  ]);
  if (encoded.length !== 4 || encoded.some((result) => !result)) return null;
  try {
    const tuple = CONTEXT_GRAPH_STORAGE_FINALIZED_READ_INTERFACE.decodeFunctionResult('getContextGraph', encoded[0]!);
    const name = CONTEXT_GRAPH_STORAGE_FINALIZED_READ_INTERFACE.decodeFunctionResult('getNameHash', encoded[1]!);
    const count = CONTEXT_GRAPH_STORAGE_FINALIZED_READ_INTERFACE.decodeFunctionResult('getContextGraphKaCount', encoded[2]!);
    const storage = HUB_STORAGE_FINALIZED_READ_INTERFACE.decodeFunctionResult('getAssetStorageAddress', encoded[3]!);
    assertCanonicalAbiResult('getContextGraph', tuple, encoded[0]!);
    assertCanonicalAbiResult('getNameHash', name, encoded[1]!);
    assertCanonicalAbiResult('getContextGraphKaCount', count, encoded[2]!);
    if (HUB_STORAGE_FINALIZED_READ_INTERFACE.encodeFunctionResult('getAssetStorageAddress', [...storage]).toLowerCase()
      !== encoded[3]!.toLowerCase()) {
      throw malformedReturn('getAssetStorageAddress returned a non-canonical ABI encoding');
    }
    return Object.freeze({
      active: tuple.active === true,
      accessPolicy: Number(tuple.accessPolicy),
      nameHash: String(name[0]).toLowerCase(),
      participantAgents: Object.freeze((tuple.participantAgents as readonly string[]).map(lowerAddress)),
      kaCount: BigInt(count[0]),
      contextGraphStorageAddress: lowerAddress(storage[0]),
    });
  } catch (cause) {
    if (cause instanceof CurrentFinalizedEvmCallErrorV1) throw cause;
    throw malformedReturn('Finalized empty-VM proof ABI result is malformed', cause);
  }
}

/**
 * Bind the strict same-anchor transport to the two ContextGraphStorage reads
 * required by the finalized RFC-64 policy seam.
 */
export function createFinalizedContextGraphRpcResolverV1(
  read: StrictCurrentFinalizedEvmReadV1,
): FinalizedContextGraphReadResolverWithSignalV1 {
  if (typeof read !== 'function') {
    throw new TypeError('Finalized Context Graph RPC resolver requires a read function');
  }

  const resolver: FinalizedContextGraphReadResolverWithSignalV1 = async (
    binding,
    signal,
  ) => {
    const contextGraphId = BigInt(binding.contextGraphId);
    let result: StrictCurrentFinalizedEvmReadResultV1;
    try {
      result = await read({
        chainId: binding.chainId,
        calls: Object.freeze([
          Object.freeze({
            to: binding.governanceContract,
            data: CONTEXT_GRAPH_STORAGE_FINALIZED_READ_INTERFACE.encodeFunctionData(
              'getContextGraph',
              [contextGraphId],
            ),
            maxReturnBytes: FINALIZED_CONTEXT_GRAPH_TUPLE_MAX_RETURN_BYTES_V1,
          }),
          Object.freeze({
            to: binding.governanceContract,
            data: CONTEXT_GRAPH_STORAGE_FINALIZED_READ_INTERFACE.encodeFunctionData(
              'getNameHash',
              [contextGraphId],
            ),
            maxReturnBytes: FINALIZED_CONTEXT_GRAPH_NAME_HASH_MAX_RETURN_BYTES_V1,
          }),
        ]),
        signal,
      });
    } catch (cause) {
      if (isAuthenticatedMissingContextGraphRevert(cause, contextGraphId)) {
        throw new FinalizedContextGraphReadErrorV1(
          'unregistered-context-graph',
          `Context Graph ${binding.contextGraphId} is not registered at the finalized anchor`,
        );
      }
      throw cause;
    }
    return decodeFinalizedContextGraphResult(binding, result);
  };

  return Object.freeze(resolver);
}

function isAuthenticatedMissingContextGraphRevert(
  cause: unknown,
  contextGraphId: bigint,
): boolean {
  if (!(cause instanceof CurrentFinalizedEvmCallErrorV1) || cause.code !== 'revert') {
    return false;
  }
  const authenticatedRevertData = readStrictCurrentFinalizedEvmRevertDataV1(cause);
  if (authenticatedRevertData === undefined) return false;
  return authenticatedRevertData === ERC721_FINALIZED_READ_ERROR_INTERFACE
    .encodeErrorResult('ERC721NonexistentToken', [contextGraphId])
    .toLowerCase();
}

function decodeFinalizedContextGraphResult(
  binding: FinalizedContextGraphBindingV1,
  result: StrictCurrentFinalizedEvmReadResultV1,
): UntrustedFinalizedContextGraphFieldsV1 {
  if (result.chainId !== binding.chainId) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'chain-mismatch',
      `Finalized Context Graph read returned chain ${result.chainId}, expected ${binding.chainId}`,
    );
  }
  if (!Array.isArray(result.returnData) || result.returnData.length !== 2) {
    throw malformedReturn('Finalized Context Graph read must return exactly two ABI results');
  }

  try {
    const contextGraph = CONTEXT_GRAPH_STORAGE_FINALIZED_READ_INTERFACE.decodeFunctionResult(
      'getContextGraph',
      result.returnData[0]!,
    );
    const nameHash = CONTEXT_GRAPH_STORAGE_FINALIZED_READ_INTERFACE.decodeFunctionResult(
      'getNameHash',
      result.returnData[1]!,
    );
    assertCanonicalAbiResult('getContextGraph', contextGraph, result.returnData[0]!);
    assertCanonicalAbiResult('getNameHash', nameHash, result.returnData[1]!);

    return Object.freeze({
      blockNumber: result.blockNumber,
      blockHash: result.blockHash,
      owner: lowerAddress(contextGraph.owner),
      active: contextGraph.active,
      accessPolicy: Number(contextGraph.accessPolicy),
      publishPolicy: Number(contextGraph.publishPolicy),
      publishAuthority: lowerAddress(contextGraph.publishAuthority),
      publishAuthorityAccountId: decimal(contextGraph.publishAuthorityAccountId),
      nameHash: String(nameHash[0]).toLowerCase(),
    });
  } catch (cause) {
    if (cause instanceof CurrentFinalizedEvmCallErrorV1) throw cause;
    throw malformedReturn('Finalized Context Graph ABI result is malformed', cause);
  }
}

function assertCanonicalAbiResult(
  functionName: 'getContextGraph' | 'getNameHash' | 'getContextGraphKaCount',
  decoded: ethers.Result,
  encoded: string,
): void {
  const canonical = CONTEXT_GRAPH_STORAGE_FINALIZED_READ_INTERFACE
    .encodeFunctionResult(functionName, [...decoded])
    .toLowerCase();
  if (canonical !== encoded) {
    throw malformedReturn(`${functionName} returned a non-canonical ABI encoding`);
  }
}

function lowerAddress(value: unknown): string {
  return String(value).toLowerCase();
}

function decimal(value: unknown): string {
  return BigInt(value as bigint).toString(10);
}

function malformedReturn(
  message: string,
  cause?: unknown,
): CurrentFinalizedEvmCallErrorV1 {
  return new CurrentFinalizedEvmCallErrorV1(
    'malformed-return',
    message,
    cause === undefined ? {} : { cause },
  );
}

import { ethers } from 'ethers';

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

// getContextGraph has nine fixed words plus a chain-capped 256-address array:
// its maximal canonical ABI result is 8,512 bytes, below this domain ceiling.
export const FINALIZED_CONTEXT_GRAPH_TUPLE_MAX_RETURN_BYTES_V1 = 9 * 1024;
export const FINALIZED_CONTEXT_GRAPH_NAME_HASH_MAX_RETURN_BYTES_V1 = 32;

const CONTEXT_GRAPH_STORAGE_FINALIZED_READ_INTERFACE = new ethers.Interface([
  'function getContextGraph(uint256 contextGraphId) view returns (address owner, address[] participantAgents, uint256 metadataBatchId, bool active, uint256 createdAt, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
  'function getNameHash(uint256 contextGraphId) view returns (bytes32)',
]);
const ERC721_FINALIZED_READ_ERROR_INTERFACE = new ethers.Interface([
  'error ERC721NonexistentToken(uint256 tokenId)',
]);

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
  functionName: 'getContextGraph' | 'getNameHash',
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

import { type EvmAddressV1 } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import { CurrentFinalizedEvmCallErrorV1 } from './current-finalized-evm-read-profile.js';
import {
  type FinalizedContextGraphBindingV1,
  type FinalizedContextGraphReadResolverV1,
  type UntrustedFinalizedContextGraphFieldsV1,
} from './finalized-context-graph-read.js';
import {
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

/**
 * Bind the strict same-anchor transport to the two ContextGraphStorage reads
 * required by the finalized RFC-64 policy seam.
 */
export function createFinalizedContextGraphRpcResolverV1(
  read: StrictCurrentFinalizedEvmReadV1,
): FinalizedContextGraphReadResolverV1 {
  if (typeof read !== 'function') {
    throw new TypeError('Finalized Context Graph RPC resolver requires a read function');
  }

  const resolver: FinalizedContextGraphReadResolverV1 = async (
    binding,
    signal,
  ) => {
    const contextGraphId = BigInt(binding.contextGraphId);
    const result = await read({
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
    return decodeFinalizedContextGraphResult(binding, result);
  };

  return Object.freeze(resolver);
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

    const [
      owner,
      _participantAgents,
      _metadataBatchId,
      active,
      _createdAt,
      accessPolicy,
      publishPolicy,
      publishAuthority,
      publishAuthorityAccountId,
    ] = contextGraph;

    return Object.freeze({
      blockNumber: result.blockNumber,
      blockHash: result.blockHash,
      owner: lowerAddress(owner),
      active,
      accessPolicy: Number(accessPolicy),
      publishPolicy: Number(publishPolicy),
      publishAuthority: lowerAddress(publishAuthority),
      publishAuthorityAccountId: decimal(publishAuthorityAccountId),
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

function lowerAddress(value: unknown): EvmAddressV1 {
  return String(value).toLowerCase() as EvmAddressV1;
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

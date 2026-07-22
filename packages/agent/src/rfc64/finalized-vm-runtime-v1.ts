import {
  assertCanonicalChainId,
  assertCanonicalDecimalU256,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertCanonicalKaId,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  assertSubGraphNameV1,
  canonicalizeContextGraphPolicyPayloadV1,
  parseCanonicalContextGraphPolicyPayloadV1,
  type ChainIdV1,
  type ContextGraphIdV1,
  type DecimalU256V1,
  type ContextGraphPolicyV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type KaIdV1,
  type NetworkIdV1,
  type SubGraphNameV1,
} from '@origintrail-official/dkg-core';
import {
  FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1,
  createFinalizedContextGraphRpcResolverV1,
  resolveFinalizedContextGraphReadWithSignalV1,
  scanFinalizedVmChainInventoryInSnapshotV1,
  type FinalizedContextGraphReadV1,
  type FinalizedVmChainCandidateV1,
  type FinalizedVmChainInventoryV1,
  type StrictCurrentFinalizedEvmReadV1,
  type StrictCurrentFinalizedEvmSnapshotScopeV1,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import {
  composeFinalizedVmSetV1,
  type ComposedFinalizedVmSetV1,
  type FinalizedVmCatalogLaneV1,
  type FinalizedVmPlacementEvidenceV1,
} from './finalized-vm-composer-v1.js';

const MAX_VM_GRAPH_IRI_BYTES_V1 = 8 * 1024;
const UTF8 = new TextEncoder();

export interface FinalizedVmMaterializationReceiptV1 {
  readonly kaId: KaIdV1;
  readonly ordinal: DecimalU64V1;
  readonly ual: string;
  readonly status: 'materialized' | 'existing';
  readonly vmGraphIri: string;
  readonly tripleCount: DecimalU64V1;
  readonly postReadDigest: Digest32V1;
}

export interface FinalizedVmMaterializeRequestV1 {
  readonly acceptedPolicy: Readonly<ContextGraphPolicyV1>;
  readonly acceptedPolicyDigest: Digest32V1;
  readonly catalogLane: Readonly<FinalizedVmCatalogLaneV1>;
  readonly finalizedContextGraph: Readonly<FinalizedContextGraphReadV1>;
  readonly candidate: Readonly<FinalizedVmChainCandidateV1>;
  readonly placement: Readonly<FinalizedVmPlacementEvidenceV1>;
  readonly row: Readonly<ComposedFinalizedVmSetV1['rows'][number]>;
  readonly signal: AbortSignal;
}

/**
 * Idempotently materialize one already-authorized row and post-read the exact VM graph.
 * A thrown error may leave earlier rows materialized; callers must not advance their
 * applied-head CAS until the complete runtime result has been returned.
 */
export interface FinalizedVmMaterializerV1 {
  (request: FinalizedVmMaterializeRequestV1):
    Promise<FinalizedVmMaterializationReceiptV1>;
}

export interface FinalizedVmRuntimeConfigV1 {
  readonly networkId: NetworkIdV1;
  readonly chainId: ChainIdV1;
  readonly contextGraphStorageAddress: EvmAddressV1;
  readonly knowledgeAssetStorageAddress: EvmAddressV1;
  readonly snapshot: StrictCurrentFinalizedEvmSnapshotScopeV1;
  readonly materialize: FinalizedVmMaterializerV1;
}

export interface FinalizedVmRuntimeRequestV1 {
  readonly catalogLane: FinalizedVmCatalogLaneV1;
  readonly onChainContextGraphId: DecimalU256V1;
  readonly acceptedPolicy: AcceptedRfc64CatalogAccessSnapshotV1;
  readonly placements: readonly FinalizedVmPlacementEvidenceV1[];
  readonly signal: AbortSignal;
}

export interface FinalizedVmRuntimeResultV1 {
  readonly acceptedPolicyDigest: Digest32V1;
  readonly finalizedContextGraph: Readonly<FinalizedContextGraphReadV1>;
  readonly inventory: Readonly<FinalizedVmChainInventoryV1>;
  readonly composed: Readonly<ComposedFinalizedVmSetV1>;
  readonly receipts: readonly Readonly<FinalizedVmMaterializationReceiptV1>[];
}

export interface FinalizedVmRuntimeV1 {
  (request: FinalizedVmRuntimeRequestV1): Promise<Readonly<FinalizedVmRuntimeResultV1>>;
}

export type FinalizedVmRuntimeErrorCodeV1 =
  | 'finalized-vm-runtime-config'
  | 'finalized-vm-runtime-request'
  | 'finalized-vm-runtime-policy'
  | 'finalized-vm-runtime-anchor'
  | 'finalized-vm-runtime-materialization';

export class FinalizedVmRuntimeErrorV1 extends Error {
  constructor(
    readonly code: FinalizedVmRuntimeErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'FinalizedVmRuntimeErrorV1';
  }
}

interface RuntimeConfigSnapshotV1 {
  readonly networkId: NetworkIdV1;
  readonly chainId: FinalizedVmChainInventoryV1['chainId'];
  readonly contextGraphStorageAddress: EvmAddressV1;
  readonly knowledgeAssetStorageAddress: EvmAddressV1;
  readonly snapshot: StrictCurrentFinalizedEvmSnapshotScopeV1;
  readonly materialize: FinalizedVmMaterializerV1;
}

interface RuntimeRequestSnapshotV1 {
  readonly catalogLane: FinalizedVmCatalogLaneV1;
  readonly onChainContextGraphId: FinalizedVmChainInventoryV1['contextGraphId'];
  readonly acceptedPolicy: Readonly<ContextGraphPolicyV1>;
  readonly acceptedPolicyDigest: Digest32V1;
  readonly placements: readonly FinalizedVmPlacementEvidenceV1[];
  readonly signal: AbortSignal;
}

interface VerifiedSnapshotV1 {
  readonly finalizedContextGraph: Readonly<FinalizedContextGraphReadV1>;
  readonly inventory: Readonly<FinalizedVmChainInventoryV1>;
  readonly composed: Readonly<ComposedFinalizedVmSetV1>;
}

/**
 * Verify public RFC-64 policy, name binding, chain inventory, and catalog placement at
 * one exact finalized anchor before invoking any triple-store materialization.
 */
export function createFinalizedVmRuntimeV1(
  input: FinalizedVmRuntimeConfigV1,
): FinalizedVmRuntimeV1 {
  const config = snapshotConfig(input);
  const runtime: FinalizedVmRuntimeV1 = async (inputRequest) => {
    const request = snapshotRequest(inputRequest);
    request.signal.throwIfAborted();

    const verified = await config.snapshot(
      { chainId: config.chainId, signal: request.signal },
      async (session): Promise<VerifiedSnapshotV1> => {
        const read: StrictCurrentFinalizedEvmReadV1 = async (readRequest) => {
          if (readRequest.chainId !== session.chainId) {
            fail('finalized-vm-runtime-anchor', 'policy read requested a different chain');
          }
          const returnData = await session.read(readRequest.calls);
          return Object.freeze({
            chainId: session.chainId,
            blockNumber: session.blockNumber,
            blockHash: session.blockHash,
            returnData,
          });
        };
        const finalizedContextGraph = await resolveFinalizedContextGraphReadWithSignalV1(
          createFinalizedContextGraphRpcResolverV1(read),
          {
            chainId: config.chainId,
            contextGraphId: request.onChainContextGraphId,
            governanceContract: config.contextGraphStorageAddress,
          },
          request.signal,
        );
        const inventory = await scanFinalizedVmChainInventoryInSnapshotV1(
          {
            networkId: config.networkId,
            chainId: config.chainId,
            contextGraphStorageAddress: config.contextGraphStorageAddress,
            knowledgeAssetStorageAddress: config.knowledgeAssetStorageAddress,
          },
          { contextGraphId: request.onChainContextGraphId, signal: request.signal },
          session,
        );
        assertExactAnchor(finalizedContextGraph, inventory);
        assertAcceptedPublicPolicy(
          config,
          request.catalogLane,
          request.acceptedPolicy,
          finalizedContextGraph,
        );

        const composed = composeFinalizedVmSetV1({
          catalogLane: request.catalogLane,
          finalizedContextGraph,
          inventory,
          placements: request.placements,
        });
        return Object.freeze({
          finalizedContextGraph,
          inventory,
          composed,
        });
      },
    );

    const receipts: Readonly<FinalizedVmMaterializationReceiptV1>[] = [];
    for (const prepared of verified.composed.materializations) {
      request.signal.throwIfAborted();
      let untrustedReceipt: FinalizedVmMaterializationReceiptV1;
      try {
        untrustedReceipt = await config.materialize(Object.freeze({
          acceptedPolicy: request.acceptedPolicy,
          acceptedPolicyDigest: request.acceptedPolicyDigest,
          catalogLane: verified.composed.catalogLane,
          finalizedContextGraph: verified.finalizedContextGraph,
          candidate: prepared.candidate,
          placement: prepared.placement,
          row: prepared.row,
          signal: request.signal,
        }));
      } catch (cause) {
        if (request.signal.aborted) request.signal.throwIfAborted();
        fail(
          'finalized-vm-runtime-materialization',
          `materializer failed at finalized ordinal ${prepared.row.ordinal}`,
          cause,
        );
      }
      request.signal.throwIfAborted();
      receipts.push(snapshotReceipt(untrustedReceipt, prepared.candidate));
    }

    return Object.freeze({
      acceptedPolicyDigest: request.acceptedPolicyDigest,
      finalizedContextGraph: verified.finalizedContextGraph,
      inventory: verified.inventory,
      composed: verified.composed,
      receipts: Object.freeze(receipts),
    });
  };
  return Object.freeze(runtime);
}

function snapshotConfig(input: FinalizedVmRuntimeConfigV1): RuntimeConfigSnapshotV1 {
  try {
    assertNetworkIdV1(input.networkId, 'finalized VM runtime networkId');
    assertCanonicalChainId(input.chainId, 'finalized VM runtime chainId');
    assertNonzeroAddress(input.contextGraphStorageAddress, 'contextGraphStorageAddress');
    assertNonzeroAddress(input.knowledgeAssetStorageAddress, 'knowledgeAssetStorageAddress');
    if (typeof input.snapshot !== 'function') throw new TypeError('snapshot is not callable');
    if (typeof input.materialize !== 'function') throw new TypeError('materialize is not callable');
  } catch (cause) {
    fail('finalized-vm-runtime-config', 'runtime config is not canonical', cause);
  }
  return Object.freeze({
    networkId: input.networkId,
    chainId: input.chainId,
    contextGraphStorageAddress: input.contextGraphStorageAddress,
    knowledgeAssetStorageAddress: input.knowledgeAssetStorageAddress,
    snapshot: input.snapshot,
    materialize: input.materialize,
  });
}

function snapshotRequest(input: FinalizedVmRuntimeRequestV1): RuntimeRequestSnapshotV1 {
  try {
    if (input.acceptedPolicy.roster !== null) {
      throw new TypeError('public finalized VM runtime forbids a private member roster');
    }
    assertCanonicalDigest(input.acceptedPolicy.policyDigest, 'accepted policy digest');
    const policy = parseCanonicalContextGraphPolicyPayloadV1(
      canonicalizeContextGraphPolicyPayloadV1(input.acceptedPolicy.policy),
    );
    assertCanonicalDecimalU256(
      input.onChainContextGraphId,
      'finalized VM runtime onChainContextGraphId',
    );
    if (input.onChainContextGraphId === '0') {
      throw new TypeError('onChainContextGraphId must be nonzero');
    }
    const catalogLane = snapshotCatalogLane(input.catalogLane);
    if (
      !Array.isArray(input.placements)
      || input.placements.length > FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1
    ) {
      throw new TypeError('placements exceed the finalized VM runtime bound');
    }
    return Object.freeze({
      catalogLane,
      onChainContextGraphId: input.onChainContextGraphId,
      acceptedPolicy: policy,
      acceptedPolicyDigest: input.acceptedPolicy.policyDigest,
      placements: Object.freeze([...input.placements]),
      signal: input.signal,
    });
  } catch (cause) {
    fail('finalized-vm-runtime-request', 'runtime request is not canonical', cause);
  }
}

function snapshotCatalogLane(input: FinalizedVmCatalogLaneV1): FinalizedVmCatalogLaneV1 {
  assertContextGraphIdV1(input.contextGraphId, 'catalogLane.contextGraphId');
  if (input.subGraphName !== null) {
    assertSubGraphNameV1(input.subGraphName, 'catalogLane.subGraphName');
  }
  return Object.freeze({
    contextGraphId: input.contextGraphId,
    subGraphName: input.subGraphName,
  });
}

function assertAcceptedPublicPolicy(
  config: RuntimeConfigSnapshotV1,
  catalogLane: FinalizedVmCatalogLaneV1,
  policy: Readonly<ContextGraphPolicyV1>,
  finalized: Readonly<FinalizedContextGraphReadV1>,
): void {
  const source = policy.source;
  const expectedNameHash = ethers.keccak256(
    ethers.toUtf8Bytes(catalogLane.contextGraphId),
  ).toLowerCase();
  const sourcePrecedesAnchor = source.kind === 'finalized-chain'
    && BigInt(source.blockNumber) <= BigInt(finalized.blockNumber);
  const sameSourceAnchor = source.kind === 'finalized-chain'
    && source.blockNumber === finalized.blockNumber;
  if (
    policy.accessPolicy !== 0
    || policy.networkId !== config.networkId
    || policy.contextGraphId !== catalogLane.contextGraphId
    || policy.governanceChainId !== config.chainId
    || policy.governanceContractAddress !== config.contextGraphStorageAddress
    || source.kind !== 'finalized-chain'
    || source.chainId !== config.chainId
    || source.contractAddress !== config.contextGraphStorageAddress
    || !sourcePrecedesAnchor
    || (sameSourceAnchor && source.blockHash !== finalized.blockHash)
    || !finalized.active
    || finalized.nameHash !== expectedNameHash
    || finalized.accessPolicy !== policy.accessPolicy
    || finalized.publishPolicy !== policy.publishPolicy
    || finalized.publishAuthority !== policy.publishAuthority
    || finalized.publishAuthorityAccountId !== policy.publishAuthorityAccountId
  ) {
    fail(
      'finalized-vm-runtime-policy',
      'accepted public policy or cleartext name binding differs from finalized chain truth',
    );
  }
}

function assertExactAnchor(
  contextGraph: Readonly<FinalizedContextGraphReadV1>,
  inventory: Readonly<FinalizedVmChainInventoryV1>,
): void {
  if (
    contextGraph.chainId !== inventory.chainId
    || contextGraph.contextGraphId !== inventory.contextGraphId
    || contextGraph.governanceContract !== inventory.contractAddress
    || contextGraph.blockNumber !== inventory.finalizedBlockNumber
    || contextGraph.blockHash !== inventory.finalizedBlockHash
  ) {
    fail(
      'finalized-vm-runtime-anchor',
      'policy/name read and VM inventory do not share one exact finalized anchor',
    );
  }
}

function snapshotReceipt(
  input: FinalizedVmMaterializationReceiptV1,
  candidate: Readonly<FinalizedVmChainCandidateV1>,
): Readonly<FinalizedVmMaterializationReceiptV1> {
  try {
    assertCanonicalKaId(input.kaId, 'materialization receipt kaId');
    assertCanonicalDecimalU64(input.ordinal, 'materialization receipt ordinal');
    assertCanonicalDecimalU64(input.tripleCount, 'materialization receipt tripleCount');
    assertCanonicalDigest(input.postReadDigest, 'materialization receipt postReadDigest');
    if (input.status !== 'materialized' && input.status !== 'existing') {
      throw new TypeError('materialization receipt status is invalid');
    }
    if (
      input.ual !== candidate.ual
      || input.kaId !== candidate.kaId
      || input.ordinal !== candidate.ordinal
    ) {
      throw new TypeError('materialization receipt does not bind the requested chain row');
    }
    assertBoundedIri(input.vmGraphIri);
  } catch (cause) {
    fail(
      'finalized-vm-runtime-materialization',
      `materializer returned an invalid receipt for finalized ordinal ${candidate.ordinal}`,
      cause,
    );
  }
  return Object.freeze({
    kaId: input.kaId,
    ordinal: input.ordinal,
    ual: input.ual,
    status: input.status,
    vmGraphIri: input.vmGraphIri,
    tripleCount: input.tripleCount,
    postReadDigest: input.postReadDigest,
  });
}

function assertNonzeroAddress(value: unknown, label: string): asserts value is EvmAddressV1 {
  assertCanonicalEvmAddress(value, label);
  if (value === `0x${'00'.repeat(20)}`) throw new TypeError(`${label} must be nonzero`);
}

function assertBoundedIri(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
    || UTF8.encode(value).byteLength > MAX_VM_GRAPH_IRI_BYTES_V1
    || /[\u0000-\u0020<>"{}|^`\\]/u.test(value)
  ) {
    throw new TypeError('vmGraphIri must be a bounded safe absolute IRI');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('vmGraphIri must be an absolute IRI');
  }
  if (parsed.protocol.length <= 1) throw new TypeError('vmGraphIri must have a scheme');
}

function fail(
  code: FinalizedVmRuntimeErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new FinalizedVmRuntimeErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}

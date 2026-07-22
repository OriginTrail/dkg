import {
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertCanonicalKaId,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  assertSubGraphNameV1,
  canonicalizeContextGraphPolicyPayloadV1,
  parseCanonicalContextGraphPolicyPayloadV1,
  readVerifiedCatalogSealBindingV1,
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

const CONFIG_KEYS = Object.freeze([
  'chainId',
  'contextGraphStorageAddress',
  'knowledgeAssetStorageAddress',
  'materialize',
  'networkId',
  'snapshot',
] as const);
const REQUEST_KEYS = Object.freeze([
  'acceptedPolicy',
  'catalogLane',
  'onChainContextGraphId',
  'placements',
  'signal',
] as const);
const ACCEPTED_POLICY_KEYS = Object.freeze(['policy', 'policyDigest', 'roster'] as const);
const CATALOG_LANE_KEYS = Object.freeze(['contextGraphId', 'subGraphName'] as const);
const RECEIPT_KEYS = Object.freeze([
  'kaId',
  'ordinal',
  'postReadDigest',
  'status',
  'tripleCount',
  'ual',
  'vmGraphIri',
] as const);
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

interface PreparedMaterializationV1 {
  readonly candidate: Readonly<FinalizedVmChainCandidateV1>;
  readonly placement: Readonly<FinalizedVmPlacementEvidenceV1>;
  readonly row: Readonly<ComposedFinalizedVmSetV1['rows'][number]>;
}

interface VerifiedSnapshotV1 {
  readonly finalizedContextGraph: Readonly<FinalizedContextGraphReadV1>;
  readonly inventory: Readonly<FinalizedVmChainInventoryV1>;
  readonly composed: Readonly<ComposedFinalizedVmSetV1>;
  readonly materializations: readonly PreparedMaterializationV1[];
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
          inventory,
          placements: request.placements,
        });
        return Object.freeze({
          finalizedContextGraph,
          inventory,
          composed,
          materializations: prepareMaterializations(inventory, composed, request.placements),
        });
      },
    );

    const receipts: Readonly<FinalizedVmMaterializationReceiptV1>[] = [];
    for (const prepared of verified.materializations) {
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

function snapshotConfig(input: unknown): RuntimeConfigSnapshotV1 {
  let fields: Record<string, unknown>;
  try {
    fields = snapshotExactRecord(input, CONFIG_KEYS);
    assertNetworkIdV1(fields.networkId, 'finalized VM runtime networkId');
    assertCanonicalChainId(fields.chainId, 'finalized VM runtime chainId');
    assertNonzeroAddress(fields.contextGraphStorageAddress, 'contextGraphStorageAddress');
    assertNonzeroAddress(fields.knowledgeAssetStorageAddress, 'knowledgeAssetStorageAddress');
    if (typeof fields.snapshot !== 'function') throw new TypeError('snapshot is not callable');
    if (typeof fields.materialize !== 'function') throw new TypeError('materialize is not callable');
  } catch (cause) {
    fail('finalized-vm-runtime-config', 'runtime config is not canonical', cause);
  }
  return Object.freeze({
    networkId: fields.networkId as NetworkIdV1,
    chainId: fields.chainId as FinalizedVmChainInventoryV1['chainId'],
    contextGraphStorageAddress: fields.contextGraphStorageAddress as EvmAddressV1,
    knowledgeAssetStorageAddress: fields.knowledgeAssetStorageAddress as EvmAddressV1,
    snapshot: fields.snapshot as StrictCurrentFinalizedEvmSnapshotScopeV1,
    materialize: fields.materialize as FinalizedVmMaterializerV1,
  });
}

function snapshotRequest(input: unknown): RuntimeRequestSnapshotV1 {
  let fields: Record<string, unknown>;
  let accepted: Record<string, unknown>;
  try {
    fields = snapshotExactRecord(input, REQUEST_KEYS);
    accepted = snapshotExactRecord(fields.acceptedPolicy, ACCEPTED_POLICY_KEYS);
    if (accepted.roster !== null) {
      throw new TypeError('public finalized VM runtime forbids a private member roster');
    }
    assertCanonicalDigest(accepted.policyDigest, 'accepted policy digest');
    const policy = parseCanonicalContextGraphPolicyPayloadV1(
      canonicalizeContextGraphPolicyPayloadV1(accepted.policy as ContextGraphPolicyV1),
    );
    if (!isAbortSignal(fields.signal)) throw new TypeError('signal is not an AbortSignal');
    const catalogLane = snapshotCatalogLane(fields.catalogLane);
    const placements = snapshotDenseArray(
      fields.placements,
      FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1,
    );
    return Object.freeze({
      catalogLane,
      onChainContextGraphId: fields.onChainContextGraphId as FinalizedVmChainInventoryV1['contextGraphId'],
      acceptedPolicy: policy,
      acceptedPolicyDigest: accepted.policyDigest,
      placements: placements as readonly FinalizedVmPlacementEvidenceV1[],
      signal: fields.signal,
    });
  } catch (cause) {
    fail('finalized-vm-runtime-request', 'runtime request is not canonical', cause);
  }
}

function snapshotCatalogLane(input: unknown): FinalizedVmCatalogLaneV1 {
  const fields = snapshotExactRecord(input, CATALOG_LANE_KEYS);
  assertContextGraphIdV1(fields.contextGraphId, 'catalogLane.contextGraphId');
  if (fields.subGraphName !== null) {
    assertSubGraphNameV1(fields.subGraphName, 'catalogLane.subGraphName');
  }
  return Object.freeze({
    contextGraphId: fields.contextGraphId as ContextGraphIdV1,
    subGraphName: fields.subGraphName as SubGraphNameV1 | null,
  });
}

function snapshotDenseArray(input: unknown, maxLength: number): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new TypeError('placements must be an ordinary array');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
  if (
    lengthDescriptor === undefined
    || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maxLength
  ) {
    throw new TypeError('placements length is outside the runtime bound');
  }
  const length = lengthDescriptor.value;
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new TypeError('placements must be dense and data-only');
    }
    output.push(descriptor.value);
  }
  if (Reflect.ownKeys(input).length !== length + 1) {
    throw new TypeError('placements must not have extra properties');
  }
  return Object.freeze(output);
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

function prepareMaterializations(
  inventory: Readonly<FinalizedVmChainInventoryV1>,
  composed: Readonly<ComposedFinalizedVmSetV1>,
  placements: readonly FinalizedVmPlacementEvidenceV1[],
): readonly PreparedMaterializationV1[] {
  const placementByKaId = new Map<string, FinalizedVmPlacementEvidenceV1>();
  for (const placement of placements) {
    const binding = readVerifiedCatalogSealBindingV1(placement.sealBinding);
    placementByKaId.set(binding.kaId, placement);
  }
  const candidatesByOrdinal = new Map(inventory.rows.map((candidate) => [
    candidate.ordinal,
    candidate,
  ]));
  return Object.freeze(composed.rows.map((row) => {
    const candidate = candidatesByOrdinal.get(row.ordinal);
    const placement = candidate === undefined ? undefined : placementByKaId.get(candidate.kaId);
    if (candidate === undefined || placement === undefined) {
      fail(
        'finalized-vm-runtime-anchor',
        `composed ordinal ${row.ordinal} lost its verified chain/catalog join`,
      );
    }
    return Object.freeze({ candidate, placement, row });
  }));
}

function snapshotReceipt(
  input: unknown,
  candidate: Readonly<FinalizedVmChainCandidateV1>,
): Readonly<FinalizedVmMaterializationReceiptV1> {
  let fields: Record<string, unknown>;
  try {
    fields = snapshotExactRecord(input, RECEIPT_KEYS);
    assertCanonicalKaId(fields.kaId, 'materialization receipt kaId');
    assertCanonicalDecimalU64(fields.ordinal, 'materialization receipt ordinal');
    assertCanonicalDecimalU64(fields.tripleCount, 'materialization receipt tripleCount');
    assertCanonicalDigest(fields.postReadDigest, 'materialization receipt postReadDigest');
    if (fields.status !== 'materialized' && fields.status !== 'existing') {
      throw new TypeError('materialization receipt status is invalid');
    }
    if (
      typeof fields.ual !== 'string'
      || fields.ual !== candidate.ual
      || fields.kaId !== candidate.kaId
      || fields.ordinal !== candidate.ordinal
    ) {
      throw new TypeError('materialization receipt does not bind the requested chain row');
    }
    assertBoundedIri(fields.vmGraphIri);
  } catch (cause) {
    fail(
      'finalized-vm-runtime-materialization',
      `materializer returned an invalid receipt for finalized ordinal ${candidate.ordinal}`,
      cause,
    );
  }
  return Object.freeze({
    kaId: fields.kaId as KaIdV1,
    ordinal: fields.ordinal as DecimalU64V1,
    ual: fields.ual as string,
    status: fields.status as FinalizedVmMaterializationReceiptV1['status'],
    vmGraphIri: fields.vmGraphIri as string,
    tripleCount: fields.tripleCount as DecimalU64V1,
    postReadDigest: fields.postReadDigest as Digest32V1,
  });
}

function snapshotExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input is not a record');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('input is not a plain record');
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new TypeError('input has unknown or missing fields');
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new TypeError('input fields must be enumerable data properties');
    }
    output[key] = descriptor.value;
  }
  return output;
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

function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object') return false;
  try {
    const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
    if (getter === undefined) return false;
    getter.call(value);
    return true;
  } catch {
    return false;
  }
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

import type {
  PublisherWalShadowMutationV1,
  PublisherWalShadowObjectReceiptV1,
  PublisherWalShadowWriter,
} from '@origintrail-official/dkg-publisher';
import {
  canonicalizeNQuadsV1,
  encodeCanonicalCbor,
  rdfLogicalKeyV1,
  type ProtocolTuple,
  type RdfPolicyAdmissionV1,
  type WalLocalCommitter,
} from '@origintrail-official/dkg-wal';
import { blake3 } from '@noble/hashes/blake3.js';
import { ethers } from 'ethers';

const PUBLISHER_REQUEST_DOMAIN = new TextEncoder().encode('dkg-wal-publisher-request-v1\0');

export interface DkgWalPublisherCommitContextV1 {
  /** Must be admitted against the current signed membership checkpoint. */
  readonly policyAdmission: RdfPolicyAdmissionV1;
  readonly writerEpoch: bigint;
  readonly memberWriterIds: readonly Uint8Array[];
  /** Omitted means the public replication view. */
  readonly visibility?: 'public' | 'private';
  /** Existing Sender Key epoch projected by the agent for a private view. */
  readonly privatePayload?: {
    readonly epochKey: Uint8Array;
    readonly keyEpoch: bigint;
  };
}

export interface DkgWalPublisherCommitContextResolverV1 {
  resolve(
    mutation: PublisherWalShadowMutationV1,
    writerId: Uint8Array,
  ): Promise<DkgWalPublisherCommitContextV1>;
}

export interface DkgWalPrivatePayloadResolutionInputV1 {
  readonly mutation: PublisherWalShadowMutationV1;
  readonly writerId: Uint8Array;
  readonly expectedKeyEpoch: bigint;
}

export type DkgWalPrivatePayloadResolverV1 = (
  input: DkgWalPrivatePayloadResolutionInputV1,
) => Promise<{ readonly epochKey: Uint8Array; readonly keyEpoch: bigint }>;

export interface DkgWalPublisherShadowWriterOptions {
  readonly committer: WalLocalCommitter;
  readonly contextResolver: DkgWalPublisherCommitContextResolverV1;
}

function address20(value: string, label: string): Uint8Array {
  try {
    return ethers.getBytes(ethers.getAddress(value));
  } catch (error) {
    throw new TypeError(`${label} must be a canonical EVM address`, { cause: error });
  }
}

function nquadLine(quad: { subject: string; predicate: string; object: string; graph: string }): string {
  const object = quad.object.startsWith('"') ? quad.object : `<${quad.object}>`;
  return `<${quad.subject}> <${quad.predicate}> ${object} <${quad.graph}> .`;
}

function canonicalNQuads(quads: readonly { subject: string; predicate: string; object: string; graph: string }[]): Uint8Array {
  return canonicalizeNQuadsV1(quads.map(nquadLine).join('\n')).bytes;
}

function key(graph: string, subject: string): string {
  return `${graph}\0${subject}`;
}

function replacements(mutation: PublisherWalShadowMutationV1): Array<{
  graphIri: string;
  subjectIri: string;
  nquads: Uint8Array;
}> {
  const scopes = new Map<string, { graph: string; subject: string }>();
  for (const quad of [...mutation.baseQuads, ...mutation.resultQuads]) {
    scopes.set(key(quad.graph, quad.subject), { graph: quad.graph, subject: quad.subject });
  }
  return [...scopes.values()]
    .sort((left, right) => key(left.graph, left.subject).localeCompare(key(right.graph, right.subject)))
    .map(scope => ({
      graphIri: scope.graph,
      subjectIri: scope.subject,
      nquads: canonicalNQuads(mutation.resultQuads.filter(quad =>
        quad.graph === scope.graph && quad.subject === scope.subject)),
    }));
}

function chainBinding(
  input: PublisherWalShadowMutationV1['chainBinding'],
): ProtocolTuple<'ChainBindingV1'> | null {
  if (!input) return null;
  return [
    input.chainId,
    input.knowledgeAssetsContract,
    input.contextGraphOnChainId,
    input.kaId,
    input.authorAddress,
    input.assertionVersion,
    input.merkleRoot,
    input.transactionHash,
    input.blockNumber,
    input.blockHash,
    input.transactionIndex,
    input.logIndex,
    input.eventType,
    input.requiredFinalityBlocks,
  ];
}

function hex(value: Uint8Array): string {
  return ethers.hexlify(value);
}

function requestDigest(
  mutation: PublisherWalShadowMutationV1,
  writerId: Uint8Array,
  logicalAuthor: Uint8Array,
  resultNQuads: Uint8Array,
  visibility: 'public' | 'private',
  keyEpoch: bigint | null,
): Uint8Array {
  const intent = encodeCanonicalCbor([
    1n,
    mutation.kind,
    mutation.operation,
    mutation.contextGraphId,
    mutation.subGraphName ?? null,
    logicalAuthor,
    mutation.logicalResource,
    writerId,
    resultNQuads,
    chainBinding(mutation.chainBinding),
    visibility,
    keyEpoch,
  ]);
  const bytes = new Uint8Array(PUBLISHER_REQUEST_DOMAIN.length + intent.length);
  bytes.set(PUBLISHER_REQUEST_DOMAIN);
  bytes.set(intent, PUBLISHER_REQUEST_DOMAIN.length);
  return blake3(bytes);
}

/**
 * Agent-owned adapter for the publisher's runtime-only mutation description.
 * It resolves only already-admitted signed policy context, encodes exact RDF
 * bytes, and delegates the sole durable representation to WalLocalCommitter.
 */
export class DkgWalPublisherShadowWriter implements PublisherWalShadowWriter {
  constructor(private readonly options: DkgWalPublisherShadowWriterOptions) {
    if (!options?.committer || !options.contextResolver) {
      throw new TypeError('WAL publisher shadow writer requires a committer and signed-policy resolver');
    }
  }

  async write(mutation: PublisherWalShadowMutationV1): Promise<PublisherWalShadowObjectReceiptV1> {
    const writerId = address20(mutation.signer.address, 'WAL signer address');
    const logicalAuthor = address20(mutation.logicalAuthorAddress, 'WAL logical author address');
    const context = await this.options.contextResolver.resolve(mutation, writerId);
    if (!context?.policyAdmission) {
      throw new Error('current admitted signed RDF policy is unavailable');
    }
    const contextVisibility = context.visibility ?? (context.privatePayload ? 'private' : 'public');
    const mutationVisibility = mutation.visibility ?? contextVisibility;
    if (mutation.visibility !== undefined && mutationVisibility !== contextVisibility) {
      throw new Error(
        `WAL mutation visibility ${mutationVisibility} does not match admitted ${contextVisibility} view`,
      );
    }
    if (contextVisibility === 'private' && context.privatePayload === undefined) {
      throw new Error('private WAL view requires the current Sender Key epoch');
    }
    if (contextVisibility === 'public' && context.privatePayload !== undefined) {
      throw new Error('public WAL view cannot use private-payload key material');
    }

    const logicalCoordinates = {
      contextGraphId: mutation.contextGraphId,
      subGraphName: mutation.subGraphName ?? null,
      authorAddress: logicalAuthor,
      knowledgeAssetUalOrRootEntity: mutation.logicalResource,
    } as const;
    const logicalKey = rdfLogicalKeyV1(logicalCoordinates);
    const baseHeads = this.options.committer.localHeads(
      context.policyAdmission.namespaceId,
      logicalKey,
    );
    const baseNQuads = canonicalNQuads(mutation.baseQuads);
    const resultNQuads = canonicalNQuads(mutation.resultQuads);
    const graphIris = [...new Set(
      [...mutation.baseQuads, ...mutation.resultQuads].map(quad => quad.graph),
    )].sort();
    if (graphIris.length === 0) {
      throw new Error('WAL RDF mutation has no exact graph scope');
    }
    if (mutation.operation === 'DELETE' && mutation.resultQuads.length !== 0) {
      throw new Error('WAL DELETE shadow mutation must have an empty result');
    }

    const committed = await this.options.committer.commitRdf({
      policyAdmission: context.policyAdmission,
      writerId,
      writerEpoch: context.writerEpoch,
      signer: mutation.signer,
      idempotencyKey: mutation.idempotencyKey,
      // Idempotency is bound to the caller's requested result, not the observed
      // base or local wall time. A retry after the production write has already
      // landed necessarily observes a different base; it must still return the
      // original WalObjectId when the desired result is byte-identical.
      requestDigest: requestDigest(
        mutation,
        writerId,
        logicalAuthor,
        resultNQuads,
        contextVisibility,
        context.privatePayload?.keyEpoch ?? null,
      ),
      mutation: {
        operation: mutation.operation,
        logicalKey: logicalCoordinates,
        memberWriterIds: context.memberWriterIds,
        parents: baseHeads,
        baseHeads,
        baseNQuads,
        allowedGraphIris: graphIris,
        source: mutation.operation === 'DELETE'
          ? { kind: 'delete-logical-key' }
          : { kind: 'replace', subjects: replacements(mutation) },
        chainBinding: chainBinding(mutation.chainBinding),
        nonConsensusTimestampMs: mutation.timestampMs === undefined
          ? null
          : BigInt(mutation.timestampMs),
      },
      ...(context.privatePayload === undefined ? {} : { privatePayload: context.privatePayload }),
      createdAtMs: mutation.timestampMs,
    });
    const receipt = committed.receipt;
    return {
      logicalResource: mutation.logicalResource,
      walObjectId: hex(receipt.walObjectId),
      checkpointId: hex(receipt.checkpointId),
      walStatus: receipt.walStatus,
      materializationStatus: receipt.materializationStatus,
      nudgeStatus: receipt.nudgeStatus,
      propagationStatus: 'not-claimed',
      sequence: receipt.sequence.toString(),
      objectCount: receipt.objectCount.toString(),
      objectSetRoot: hex(receipt.objectSetRoot),
      ...(receipt.shadowError === undefined ? {} : { shadowError: receipt.shadowError }),
      ...(receipt.nudgeError === undefined ? {} : { nudgeError: receipt.nudgeError }),
    };
  }
}

export function createDkgWalPublisherShadowWriter(
  options: DkgWalPublisherShadowWriterOptions,
): DkgWalPublisherShadowWriter {
  return new DkgWalPublisherShadowWriter(options);
}

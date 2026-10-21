// SPDX-License-Identifier: Apache-2.0
import { MemoryLayer, contextGraphMetaUri, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata, materializedVersionQuad,
  parseConfirmedGraphKnowledgeAssetMetadataEnvelope, confirmedGraphKnowledgeAssetProof,
  type LocallyTrustedKnowledgeAssetControlEnvelope, type ConfirmedGraphKnowledgeAssetProof,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { hexlify } from 'ethers';
import type { PublishedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle.js';
import type { ConfirmedNamedKaVmPublication } from './named-ka-vm-lifecycle-recovery-error.js';
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';

export interface ConfirmedNamedKaVmPublicationDeployment {
  readonly chainId: string;
  readonly lifecycleAddress: string;
}
export interface ConfirmedNamedKaVmLifecycleInput extends PublishedNamedKaVmLifecycleInput {
  readonly assertionVersion: string;
  /** Bound by the admitted publication seal for every new confirmed command. */
  readonly publicationDeployment: ConfirmedNamedKaVmPublicationDeployment;
  readonly materialization?: ConfirmedLifecycleMaterialization;
  readonly priorMerkleRoot?: string;
}
/** Immutable public recovery material; private plaintext never enters the journal. */
export interface ConfirmedLifecycleMaterialization {
  readonly kaUal: string;
  readonly publicQuads: readonly Quad[];
  readonly metadataQuads: readonly Quad[];
}
export interface ConfirmedLifecyclePublicSnapshot extends LocallyTrustedKnowledgeAssetControlEnvelope {
  readonly publicQuads: readonly Quad[];
}
const rootHex = (root: string | Uint8Array): string => (typeof root === 'string' ? root : hexlify(root)).replace(/^0x/, '').toLowerCase();
export interface ValidatedLifecycleMaterialization extends ConfirmedLifecycleMaterialization {
  readonly proof: ConfirmedGraphKnowledgeAssetProof;
}
declare const validatedLifecycleCommand: unique symbol;
/** Only admission and journal decoding construct executable, frozen recovery commands. */
export type ValidatedLifecycleRepairCommand = Omit<Readonly<ConfirmedNamedKaVmLifecycleInput>, 'materialization'> & {
  readonly [validatedLifecycleCommand]: true;
  readonly materialization?: ValidatedLifecycleMaterialization;
};
function invalid(): never {
  throw new NamedKaVmLifecycleIntegrityError('Invalid confirmed named KA lifecycle repair evidence');
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return invalid();
  return value;
}
function root(value: unknown): string {
  const text = string(value);
  if (!/^(0x)?[0-9a-f]{64}$/i.test(text)) return invalid();
  return text.toLowerCase().replace(/^0x/, '');
}
/** Canonical field readers also let the disk codec retain incomplete historical facts. */
export function normalizeLifecyclePackedIdentity(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << 256n) return invalid();
  return value;
}
export function normalizeLifecyclePublicationDeployment(value: unknown): ConfirmedNamedKaVmPublicationDeployment {
  const deployment = record(value);
  const chainId = string(deployment['chainId']), lifecycleAddress = string(deployment['lifecycleAddress']);
  if (!/^(0|[1-9][0-9]*)$/.test(chainId) || BigInt(chainId) >= 1n << 256n || !/^0x[0-9a-f]{40}$/i.test(lifecycleAddress)) return invalid();
  return Object.freeze({ chainId, lifecycleAddress: lifecycleAddress.toLowerCase() });
}
export function normalizeLifecycleCoordinates(value: unknown): Omit<ConfirmedNamedKaVmLifecycleInput, 'materialization' | 'packedKaId' | 'publicationDeployment'> {
  const input = record(value);
  if ('tentative' in input) return invalid();
  const assertionVersion = string(input['assertionVersion']);
  if (!/^[1-9][0-9]*$/.test(assertionVersion)) return invalid();
  return Object.freeze({
    contextGraphId: string(input['contextGraphId']), agentAddress: string(input['agentAddress']), name: string(input['name']),
    publishedUal: string(input['publishedUal']), merkleRoot: root(input['merkleRoot']), assertionVersion,
    ...(input['subGraphName'] === undefined ? {} : { subGraphName: string(input['subGraphName']) }),
    ...(input['priorMerkleRoot'] === undefined ? {} : { priorMerkleRoot: root(input['priorMerkleRoot']) }),
  });
}
/** Fresh executable evidence always requires complete deployment and identity binding. */
export function normalizeLifecycleRepairInput(value: unknown): ValidatedLifecycleRepairCommand {
  const input = record(value);
  const coordinates = { ...normalizeLifecycleCoordinates(input),
    packedKaId: normalizeLifecyclePackedIdentity(input['packedKaId']),
    publicationDeployment: normalizeLifecyclePublicationDeployment(input['publicationDeployment']),
  };
  return Object.freeze({ ...coordinates,
    ...(input['materialization'] === undefined ? {} : {
      materialization: normalizeLifecycleMaterialization(input['materialization'], coordinates),
    }),
  }) as ValidatedLifecycleRepairCommand;
}

export interface ConfirmedNamedKaVmCoordinates {
  readonly contextGraphId: string;
  readonly agentAddress: string;
  readonly name: string;
  readonly subGraphName?: string;
  readonly priorMerkleRoot?: string;
  /** The authoritative graph-scoped identity resolved by the caller. */
  readonly packedKaId: bigint;
}

/** Derive repair evidence once from the admitted confirmation, never from a second root/version description. */
export function confirmedNamedKaVmLifecycleInput(
  publication: ConfirmedNamedKaVmPublication,
  coordinates: ConfirmedNamedKaVmCoordinates,
  snapshot?: ConfirmedLifecyclePublicSnapshot,
): ConfirmedNamedKaVmLifecycleInput {
  const { seal } = publication;
  if (publication.status !== 'confirmed' || seal.kaUal === undefined || seal.assertionVersion === undefined) {
    throw new NamedKaVmLifecycleIntegrityError('Confirmed named KA repair requires a validated graph-scoped publication');
  }
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  const input: ConfirmedNamedKaVmLifecycleInput = {
    contextGraphId: coordinates.contextGraphId, name: coordinates.name, agentAddress: coordinates.agentAddress,
    ...(coordinates.subGraphName === undefined ? {} : { subGraphName: coordinates.subGraphName }),
    ...(coordinates.priorMerkleRoot === undefined ? {} : { priorMerkleRoot: coordinates.priorMerkleRoot }),
    packedKaId: coordinates.packedKaId,
    publishedUal: publication.ual, merkleRoot: hexlify(seal.merkleRoot), assertionVersion: scope.assertionVersion,
    publicationDeployment: Object.freeze({ chainId: seal.chainId.toString(), lifecycleAddress: seal.kav10Address }),
  };
  return Object.freeze({ ...input, ...(snapshot === undefined ? {} : { materialization: confirmedLifecycleMaterialization(input, publication, snapshot) }) });
}

export function confirmedLifecycleMaterialization(input: ConfirmedNamedKaVmLifecycleInput,
  publication: ConfirmedNamedKaVmPublication, snapshot: ConfirmedLifecyclePublicSnapshot,
): ConfirmedLifecycleMaterialization {
  const { seal, onChainResult: receipt } = publication;
  const scope = createGraphKnowledgeAssetScope(seal.kaUal!, input.assertionVersion);
  const graph = knowledgeAssetLayerGraphUri(input.contextGraphId, MemoryLayer.VerifiableMemory, scope, input.subGraphName);
  const version = { blockNumber: receipt?.blockNumber ?? 0, txIndex: receipt?.txIndex ?? 0 };
  const metadataQuads = generateGraphKnowledgeAssetMetadata({
    ual: scope.ual, contextGraphId: input.contextGraphId, subGraphName: input.subGraphName,
    merkleRoot: seal.merkleRoot, assertionVersion: scope.assertionVersion,
    publicTripleCount: seal.publicTripleCount!, privateTripleCount: seal.privateTripleCount,
    privateMerkleRoot: seal.privateMerkleRoot, assertionGraph: graph,
    publisherPeerId: snapshot.publisherPeerId, accessPolicy: snapshot.accessPolicy, allowedPeers: snapshot.allowedPeers,
    authorAddress: seal.authorAddress, timestamp: new Date(seal.finalizedAtIso),
  }, { status: 'confirmed', confirmation: receipt ? { kind: 'transaction', provenance: {
    txHash: receipt.txHash, blockNumber: receipt.blockNumber, blockTimestamp: receipt.blockTimestamp ?? 0,
    publisherAddress: receipt.publisherAddress, batchId: input.packedKaId, chainId: seal.chainId.toString(),
  } } : { kind: 'finalized-materialization', provenance: { batchId: input.packedKaId, materializedVersion: version } } });
  if (receipt) metadataQuads.push(materializedVersionQuad(contextGraphMetaUri(input.contextGraphId), scope.ual, version));
  return Object.freeze({ kaUal: scope.ual,
    publicQuads: Object.freeze(snapshot.publicQuads.map(q => Object.freeze({ ...q, graph: '' }))),
    metadataQuads: Object.freeze(metadataQuads.map(q => Object.freeze(q))) });
}

/** Validate disk and in-process evidence identically before any graph-store work. */
export function normalizeLifecycleMaterialization(value: unknown, input: ConfirmedNamedKaVmLifecycleInput): ValidatedLifecycleMaterialization {
  const invalid = (): never => { throw new NamedKaVmLifecycleIntegrityError('Invalid confirmed lifecycle public recovery snapshot'); };
  if (typeof value !== 'object' || value === null) return invalid();
  const fields = value as Record<string, unknown>;
  const quads = (raw: unknown): Quad[] => {
    if (!Array.isArray(raw)) return invalid();
    return raw.map(q => {
      if (typeof q !== 'object' || q === null || ['subject', 'predicate', 'object', 'graph'].some(k => typeof q[k] !== 'string')) return invalid();
      return { subject: q.subject, predicate: q.predicate, object: q.object, graph: q.graph };
    });
  };
  if (typeof fields.kaUal !== 'string') return invalid();
  const scope = createGraphKnowledgeAssetScope(fields.kaUal, input.assertionVersion);
  if (((BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber)) !== input.packedKaId) return invalid();
  const publicQuads = quads(fields.publicQuads).map(q => ({ ...q, graph: '' }));
  const metadataQuads = quads(fields.metadataQuads);
  const meta = contextGraphMetaUri(input.contextGraphId);
  if (metadataQuads.some(q => q.subject !== scope.ual || q.graph !== meta)) return invalid();
  const parsed = parseConfirmedGraphKnowledgeAssetMetadataEnvelope(metadataQuads, { contextGraphId: input.contextGraphId, ual: scope.ual });
  if (parsed.state !== 'confirmed' || parsed.envelope.assertionVersion !== input.assertionVersion
    || parsed.envelope.subGraphName !== input.subGraphName || parsed.envelope.batchId !== input.packedKaId
    || rootHex(parsed.envelope.merkleRoot) !== rootHex(input.merkleRoot)
    || parsed.envelope.publicTripleCount !== publicQuads.length
    || rootHex(computeFlatKCRootV10(publicQuads, parsed.envelope.privateMerkleRoot ? [parsed.envelope.privateMerkleRoot] : [])) !== rootHex(input.merkleRoot)) return invalid();
  const model = Object.freeze({ kaUal: scope.ual, publicQuads: Object.freeze(publicQuads.map(q => Object.freeze(q))),
    metadataQuads: Object.freeze(metadataQuads.map(q => Object.freeze(q))), proof: confirmedGraphKnowledgeAssetProof(parsed.envelope) });
  return model;
}

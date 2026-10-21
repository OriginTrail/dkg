// SPDX-License-Identifier: Apache-2.0
import { MemoryLayer, contextGraphMetaUri, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata, materializedVersionQuad,
  parseConfirmedGraphKnowledgeAssetMetadataEnvelope, confirmedGraphKnowledgeAssetProof, sameConfirmedGraphKnowledgeAssetProof, reconcileConfirmedGraphKnowledgeAssetMetadata,
  readCurrentAssertionVersion, withMaterializationLock, reconcileConfirmedKnowledgeAssetControls, overlaySelectedKnowledgeAssetControls, type LocallyTrustedKnowledgeAssetControlEnvelope, type ConfirmedGraphKnowledgeAssetProof,
} from '@origintrail-official/dkg-publisher';
import { tryReplaceGraphAndSubjectAtomically, tryReplaceGraphAtomically, tryReplaceSubjectAtomically, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { hexlify, getBytes } from 'ethers';
import { mutatePublishedNamedKaVmLifecycle, type NamedKaVmLifecycleApplyOptions } from './named-ka-vm-lifecycle.js';
import type { ValidatedLifecycleRepairCommand } from './named-ka-vm-lifecycle-repair-journal.js';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-repair.js';
import type { ConfirmedNamedKaVmPublication } from './named-ka-vm-lifecycle-recovery-error.js';
import { verifyExactGraphContent } from './exact-graph-content-verifier.js';
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';

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
/** Persist the stable wire representation; execution-only validated proof is reconstructed at decode. */
export function lifecycleMaterializationWire(snapshot: ConfirmedLifecycleMaterialization): ConfirmedLifecycleMaterialization {
  return { kaUal: snapshot.kaUal, publicQuads: snapshot.publicQuads, metadataQuads: snapshot.metadataQuads };
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

/** Caller owns the lifecycle lock. Share the publisher's materialization lock and worker fence. */
export async function applyMaterializedConfirmedLifecycle(store: TripleStore, input: ValidatedLifecycleRepairCommand,
  options: NamedKaVmLifecycleApplyOptions,
): Promise<void> {
  const scope = createGraphKnowledgeAssetScope(input.materialization?.kaUal ?? input.publishedUal, input.assertionVersion);
  if (((BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber)) !== input.packedKaId) {
    throw new NamedKaVmLifecycleIntegrityError('Confirmed lifecycle UAL differs from its packed identity');
  }
  const meta = contextGraphMetaUri(input.contextGraphId);
  const graph = knowledgeAssetLayerGraphUri(input.contextGraphId, MemoryLayer.VerifiableMemory, scope, input.subGraphName);
  const snapshot = input.materialization;
  await withMaterializationLock(meta, scope.ual, async () => {
    const capability = store.commitment;
    const barrier = capability && (capability.durability === 'restart-durable' || options.persistence === 'process-local') ? capability.capture() : undefined;
    if (!barrier) throw Object.assign(new Error('Confirmed lifecycle repair awaits an explicitly certified persistence barrier'), { code: 'KA_VM_LIFECYCLE_DURABILITY_UNAVAILABLE' });
    const current = await readCurrentAssertionVersion(store, meta, scope.ual);
    if (current !== undefined && current > BigInt(input.assertionVersion)) throw new Error('Confirmed lifecycle repair awaits newer local materialization reconciliation');
    const metadataRead = await store.query(`CONSTRUCT { <${scope.ual}> ?p ?o } WHERE { GRAPH <${meta}> { <${scope.ual}> ?p ?o } }`);
    if (metadataRead.type !== 'quads') throw new Error('Confirmed lifecycle metadata read did not return quads');
    const metadata = metadataRead.quads.map(q => ({ ...q, graph: meta }));
    const existing = parseConfirmedGraphKnowledgeAssetMetadataEnvelope(metadata, { contextGraphId: input.contextGraphId, ual: scope.ual });
    const existingProof = existing.state === 'confirmed' ? confirmedGraphKnowledgeAssetProof(existing.envelope) : undefined;
    const sameCoordinates = existingProof?.assertionVersion === input.assertionVersion && existingProof.assertionGraph === graph
      && existingProof.merkleRoot === rootHex(input.merkleRoot) && existingProof.batchId === input.packedKaId.toString()
      && existingProof.subGraphName === input.subGraphName;
    const proof = snapshot?.proof ?? (sameCoordinates ? existingProof : undefined);
    const exactMetadata = sameCoordinates && (!snapshot || sameConfirmedGraphKnowledgeAssetProof(existingProof!, snapshot.proof));
    if (!proof) throw new Error('Confirmed lifecycle repair awaits its verified public materialization evidence');
    const content = await verifyExactGraphContent(store, {
      graphUri: proof.assertionGraph, publicTripleCount: proof.publicTripleCount,
      privateMerkleRoot: proof.privateMerkleRoot ? getBytes(`0x${proof.privateMerkleRoot}`) : undefined,
      expectedMerkleRoot: getBytes(`0x${proof.merkleRoot}`), source: 'agent.publish.confirmedLifecyclePayload',
    });
    const matches = content.status === 'verified';
    if (!exactMetadata && !snapshot) throw new Error('Confirmed lifecycle repair awaits its original public payload');
    const recoveredBase = snapshot
      ? reconcileConfirmedGraphKnowledgeAssetMetadata(snapshot, metadata, current === BigInt(input.assertionVersion))
      : metadata;
    const controls = await reconcileConfirmedKnowledgeAssetControls(store, { metaGraph: meta, ual: scope.ual,
      anchor: { assertionVersion: input.assertionVersion, merkleRoot: getBytes(`0x${proof.merkleRoot}`) },
      metadataQuads: snapshot?.metadataQuads ?? metadata, restoreMissing: snapshot !== undefined });
    const recoveredMetadata = overlaySelectedKnowledgeAssetControls(recoveredBase, controls);
    const canonical = (rows: readonly Quad[]) => rows.map(q => JSON.stringify([q.predicate, q.object])).sort().join('\n');
    const metadataMatches = exactMetadata && canonical(metadata) === canonical(recoveredMetadata);
    if (!matches || !metadataMatches) {
      let replaced: boolean;
      if (matches) {
        replaced = await tryReplaceSubjectAtomically(store, meta, scope.ual, recoveredMetadata, { source: 'agent.publish.confirmedLifecycleControls' });
      } else {
        if (!snapshot) throw new Error('Confirmed lifecycle repair awaits its original public payload');
        const payload = snapshot.publicQuads.map(q => ({ ...q, graph }));
        replaced = metadataMatches
          ? await tryReplaceGraphAtomically(store, graph, payload, { source: 'agent.publish.confirmedLifecyclePayload' })
          : await tryReplaceGraphAndSubjectAtomically(store, graph, payload, meta, scope.ual, recoveredMetadata, { source: 'agent.publish.confirmedLifecycleMaterialization' });
      }
      if (!replaced) throw new Error('Confirmed lifecycle recovery requires atomic materialization replacement');
    }
    await mutatePublishedNamedKaVmLifecycle(store, input, options.preserveVerifiedVmProof);
    // This outer barrier owns the payload read/replacement as well as the lifecycle write.
    await barrier({ source: 'agent.publish.confirmedLifecycleMaterializationFlush' });
  });
}

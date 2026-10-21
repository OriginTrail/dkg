// SPDX-License-Identifier: Apache-2.0
import { MemoryLayer, contextGraphMetaUri, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata, materializedVersionQuad,
  parseConfirmedGraphKnowledgeAssetMetadataEnvelope,
  readCurrentAssertionVersion, withMaterializationLock, overlayLocallyTrustedKnowledgeAssetControls, readLocallyTrustedKnowledgeAssetControlEnvelope, replaceLocallyTrustedKnowledgeAssetControls, type LocallyTrustedKnowledgeAssetControlEnvelope,
} from '@origintrail-official/dkg-publisher';
import { tryReplaceGraphAndSubjectAtomically, tryReplaceGraphAtomically, tryReplaceSubjectAtomically, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { hexlify } from 'ethers';
import { mutatePublishedNamedKaVmLifecycle, type NamedKaVmLifecycleApplyOptions } from './named-ka-vm-lifecycle.js';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-repair.js';
import type { ConfirmedNamedKaVmPublication } from './named-ka-vm-lifecycle-recovery-error.js';
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
  return normalizeLifecycleMaterialization({ kaUal: scope.ual, publicQuads: snapshot.publicQuads, metadataQuads }, input);
}

/** Validate disk and in-process evidence identically before any graph-store work. */
export function normalizeLifecycleMaterialization(value: unknown, input: ConfirmedNamedKaVmLifecycleInput): ConfirmedLifecycleMaterialization {
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
  return Object.freeze({ kaUal: scope.ual, publicQuads: Object.freeze(publicQuads.map(q => Object.freeze(q))),
    metadataQuads: Object.freeze(metadataQuads.map(q => Object.freeze(q))) });
}

/** Caller owns the lifecycle lock. Share the publisher's materialization lock and worker fence. */
export async function applyMaterializedConfirmedLifecycle(store: TripleStore, input: ConfirmedNamedKaVmLifecycleInput,
  options: NamedKaVmLifecycleApplyOptions,
): Promise<void> {
  const scope = createGraphKnowledgeAssetScope(input.materialization?.kaUal ?? input.publishedUal, input.assertionVersion);
  if (((BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber)) !== input.packedKaId) {
    throw new NamedKaVmLifecycleIntegrityError('Confirmed lifecycle UAL differs from its packed identity');
  }
  const meta = contextGraphMetaUri(input.contextGraphId);
  const graph = knowledgeAssetLayerGraphUri(input.contextGraphId, MemoryLayer.VerifiableMemory, scope, input.subGraphName);
  const snapshot = input.materialization === undefined ? undefined : normalizeLifecycleMaterialization(input.materialization, input);
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
    const exactMetadata = existing.state === 'confirmed' && existing.envelope.assertionVersion === input.assertionVersion
      && existing.envelope.assertionGraph === graph && rootHex(existing.envelope.merkleRoot) === rootHex(input.merkleRoot);
    const envelope = snapshot === undefined ? (exactMetadata && existing.state === 'confirmed' ? existing.envelope : undefined)
      : parseConfirmedGraphKnowledgeAssetMetadataEnvelope(snapshot.metadataQuads, { contextGraphId: input.contextGraphId, ual: scope.ual });
    const proof = envelope && 'state' in envelope ? (envelope.state === 'confirmed' ? envelope.envelope : undefined) : envelope;
    if (!proof) throw new Error('Confirmed lifecycle repair awaits its verified public materialization evidence');
    const result = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    if (result.type !== 'quads') throw new Error('Confirmed lifecycle payload read did not return quads');
    const matches = result.quads.length === proof.publicTripleCount
      && rootHex(computeFlatKCRootV10(result.quads, proof.privateMerkleRoot ? [proof.privateMerkleRoot] : [])) === rootHex(input.merkleRoot);
    const controlEvidence = snapshot?.metadataQuads ?? metadata;
    const exactControls = await readLocallyTrustedKnowledgeAssetControlEnvelope(store, meta, scope.ual, controlEvidence, {}, 'exact');
    if (snapshot && !exactControls) await replaceLocallyTrustedKnowledgeAssetControls(store, scope.ual, snapshot.metadataQuads);
    if (!exactMetadata && !snapshot) throw new Error('Confirmed lifecycle repair awaits its original public payload');
    // Keep receipt provenance and all non-control rows when immutable metadata already matches.
    const recoveredMetadata = snapshot || exactControls
      ? await overlayLocallyTrustedKnowledgeAssetControls(store, meta, scope.ual, exactMetadata ? metadata : snapshot!.metadataQuads) : metadata;
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

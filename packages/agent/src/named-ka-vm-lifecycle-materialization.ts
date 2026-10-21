// SPDX-License-Identifier: Apache-2.0
import { MemoryLayer, contextGraphMetaUri, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata, materializedVersionQuad,
  parseConfirmedGraphKnowledgeAssetMetadataEnvelope, preserveGraphKnowledgeAssetReceiptProvenanceV1,
  readCurrentAssertionVersion, withMaterializationLock, reconcileConfirmedKnowledgeAssetControls, overlaySelectedKnowledgeAssetControls, type LocallyTrustedKnowledgeAssetControlEnvelope, type ConfirmedGraphKnowledgeAssetMetadataEnvelope,
} from '@origintrail-official/dkg-publisher';
import { tryReplaceGraphAndSubjectAtomically, tryReplaceGraphAtomically, tryReplaceSubjectAtomically, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { hexlify, getBytes } from 'ethers';
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
/** Validated execution proof contains no mutable byte arrays or RDF parsing ambiguity. */
export interface ConfirmedLifecycleProof {
  readonly assertionVersion: string;
  readonly publicTripleCount: number;
  readonly privateTripleCount: number;
  readonly privateMerkleRoot?: string;
  readonly assertionGraph: string;
  readonly subGraphName?: string;
  readonly merkleRoot: string;
  readonly batchId: string;
}
export interface ValidatedLifecycleMaterialization extends ConfirmedLifecycleMaterialization {
  readonly proof: ConfirmedLifecycleProof;
}
const validated = new WeakMap<object, { binding: string; model: ValidatedLifecycleMaterialization }>();
const binding = (input: ConfirmedNamedKaVmLifecycleInput) => JSON.stringify([
  input.contextGraphId, input.subGraphName, input.assertionVersion, input.packedKaId.toString(), rootHex(input.merkleRoot),
]);
function proofFromEnvelope(envelope: ConfirmedGraphKnowledgeAssetMetadataEnvelope): ConfirmedLifecycleProof {
  return Object.freeze({ assertionVersion: envelope.assertionVersion, publicTripleCount: envelope.publicTripleCount,
    privateTripleCount: envelope.privateTripleCount, privateMerkleRoot: envelope.privateMerkleRoot && rootHex(envelope.privateMerkleRoot),
    assertionGraph: envelope.assertionGraph, subGraphName: envelope.subGraphName,
    merkleRoot: rootHex(envelope.merkleRoot), batchId: envelope.batchId.toString() });
}
/** Persist the stable wire representation; execution-only validated proof is reconstructed at decode. */
export function lifecycleMaterializationWire(snapshot: ConfirmedLifecycleMaterialization): ConfirmedLifecycleMaterialization {
  return { kaUal: snapshot.kaUal, publicQuads: snapshot.publicQuads, metadataQuads: snapshot.metadataQuads };
}
const immutablePredicates = new Set(['contentScopeVersion', 'assertionVersion', 'publicTripleCount', 'privateTripleCount',
  'privateMerkleRoot', 'assertionGraph', 'subGraphName', 'merkleRoot', 'batchId', 'kaUal', 'status'].map(name => `http://dkg.io/ontology/${name}`));
function reconcileImmutableMetadata(snapshot: ValidatedLifecycleMaterialization, metadata: readonly Quad[], sameVersion: boolean, contextGraphId: string): Quad[] {
  const root = snapshot.metadataQuads.find(q => q.predicate === 'http://dkg.io/ontology/merkleRoot')!;
  const roots = metadata.filter(q => q.predicate === root.predicate);
  if (!sameVersion || roots.length !== 1) return [...snapshot.metadataQuads];
  // Use the canonical parser for the stored root even when another immutable field is corrupt.
  const anchored = parseConfirmedGraphKnowledgeAssetMetadataEnvelope(
    [...snapshot.metadataQuads.filter(q => q.predicate !== root.predicate), ...roots], { contextGraphId, ual: snapshot.kaUal });
  if (anchored.state !== 'confirmed' || rootHex(anchored.envelope.merkleRoot) !== snapshot.proof.merkleRoot) return [...snapshot.metadataQuads];
  // Same version/root receipt provenance and unrelated rows survive even a malformed count/identity.
  const canonical = preserveGraphKnowledgeAssetReceiptProvenanceV1(snapshot.metadataQuads, metadata);
  const replacedPredicates = new Set([...immutablePredicates, ...['transactionHash', 'materializedVersion', 'confirmationKind'].map(name => `http://dkg.io/ontology/${name}`)]);
  const existingPredicates = new Set(metadata.map(q => q.predicate));
  return [...metadata.filter(q => !replacedPredicates.has(q.predicate)),
    ...canonical.filter(q => replacedPredicates.has(q.predicate) || !existingPredicates.has(q.predicate))];
}


export function confirmedLifecycleMaterialization(input: ConfirmedNamedKaVmLifecycleInput,
  publication: ConfirmedNamedKaVmPublication, snapshot: ConfirmedLifecyclePublicSnapshot,
): ValidatedLifecycleMaterialization {
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
export function normalizeLifecycleMaterialization(value: unknown, input: ConfirmedNamedKaVmLifecycleInput): ValidatedLifecycleMaterialization {
  const invalid = (): never => { throw new NamedKaVmLifecycleIntegrityError('Invalid confirmed lifecycle public recovery snapshot'); };
  if (typeof value !== 'object' || value === null) return invalid();
  const cached = validated.get(value);
  if (cached) return cached.binding === binding(input) ? cached.model : invalid();
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
    metadataQuads: Object.freeze(metadataQuads.map(q => Object.freeze(q))), proof: proofFromEnvelope(parsed.envelope) });
  validated.set(model, { binding: binding(input), model });
  return model;
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
    const existingProof = existing.state === 'confirmed' ? proofFromEnvelope(existing.envelope) : undefined;
    const sameCoordinates = existingProof?.assertionVersion === input.assertionVersion && existingProof.assertionGraph === graph
      && existingProof.merkleRoot === rootHex(input.merkleRoot) && existingProof.batchId === input.packedKaId.toString()
      && existingProof.subGraphName === input.subGraphName;
    const proof = snapshot?.proof ?? (sameCoordinates ? existingProof : undefined);
    const exactMetadata = sameCoordinates && (!snapshot || JSON.stringify(existingProof) === JSON.stringify(snapshot.proof));
    if (!proof) throw new Error('Confirmed lifecycle repair awaits its verified public materialization evidence');
    const result = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    if (result.type !== 'quads') throw new Error('Confirmed lifecycle payload read did not return quads');
    const matches = result.quads.length === proof.publicTripleCount
      && rootHex(computeFlatKCRootV10(result.quads, proof.privateMerkleRoot ? [getBytes(`0x${proof.privateMerkleRoot}`)] : [])) === rootHex(input.merkleRoot);
    if (!exactMetadata && !snapshot) throw new Error('Confirmed lifecycle repair awaits its original public payload');
    const recoveredBase = exactMetadata ? metadata : reconcileImmutableMetadata(snapshot!, metadata, current === BigInt(input.assertionVersion), input.contextGraphId);
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

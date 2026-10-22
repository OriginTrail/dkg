// SPDX-License-Identifier: Apache-2.0
import { MemoryLayer, contextGraphMetaUri, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { parseConfirmedGraphKnowledgeAssetMetadataEnvelope, confirmedGraphKnowledgeAssetProof,
  sameConfirmedGraphKnowledgeAssetProof, reconcileConfirmedGraphKnowledgeAssetMetadata, reconcileConfirmedNamedAssertion,
  readCurrentAssertionVersion, withMaterializationLock, reconcileConfirmedKnowledgeAssetControls, overlaySelectedKnowledgeAssetControls,
} from '@origintrail-official/dkg-publisher';
import { tryReplaceGraphAndSubjectAtomically, tryReplaceGraphAtomically, tryReplaceSubjectAtomically, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { getBytes } from 'ethers';
import { mutatePublishedNamedKaVmLifecycle, type NamedKaVmLifecycleApplyOptions } from './named-ka-vm-lifecycle.js';
import type { ValidatedLifecycleRepairCommand } from './named-ka-vm-lifecycle-evidence.js';
import { verifyExactGraphContent } from './exact-graph-content-verifier.js';
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import { packKnowledgeAssetIdFromIdentity } from './ka-identity.js';

/** Caller owns the lifecycle lock. Share the publisher's materialization lock and worker fence. */
export async function applyMaterializedConfirmedLifecycle(store: TripleStore, input: ValidatedLifecycleRepairCommand,
  options: NamedKaVmLifecycleApplyOptions,
): Promise<void> {
  const scope = createGraphKnowledgeAssetScope(input.materialization?.kaUal ?? input.publishedUal, input.assertionVersion);
  if (packKnowledgeAssetIdFromIdentity(scope) !== input.packedKaId) {
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
      && existingProof.merkleRoot === input.merkleRoot && existingProof.batchId === input.packedKaId.toString()
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
    // Claim the named slot before touching its physical graphs or controls.
    // The publisher shares the normal allocation fence and preserves newer drafts.
    try { await reconcileConfirmedNamedAssertion(store, { ...input, kaUal: scope.ual }, proof, input.namedSeal); }
    catch (error) {
      if ((error as { code?: string }).code === 'CONFIRMED_NAMED_ASSERTION_INTEGRITY') throw new NamedKaVmLifecycleIntegrityError('Invalid confirmed named assertion seal evidence');
      throw error;
    }
    const recoveredBase = reconcileConfirmedGraphKnowledgeAssetMetadata(
      snapshot ?? { metadataQuads: metadata, proof }, metadata, current === BigInt(input.assertionVersion));
    const controls = await reconcileConfirmedKnowledgeAssetControls(store, { metaGraph: meta, ual: scope.ual,
      anchor: { assertionVersion: input.assertionVersion, merkleRoot: getBytes(`0x${proof.merkleRoot}`) },
      metadataQuads: snapshot?.metadataQuads ?? metadata, restoreMissing: snapshot !== undefined });
    if (controls.length === 0) throw new Error('Confirmed lifecycle repair awaits exact-version trusted access controls');
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

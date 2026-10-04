// SPDX-License-Identifier: Apache-2.0

import {
  MemoryLayer,
  assertionLifecycleUri,
  contextGraphAssertionUri,
  contextGraphLayerUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import {
  deleteByPatternWithoutCount,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import type { DKGPublisher } from '@origintrail-official/dkg-publisher';
import { VM_CURRENT_ASSERTION_PRED, WM_CURRENT_ASSERTION_PRED } from '@origintrail-official/dkg-publisher';
import { stampLifecyclePointerIfDivergedFromVm } from './lifecycle-pointer-writer.js';
import { replaceNamedKaVmDraftSubject, withNamedKaVmMetadataLock } from './named-ka-vm-metadata.js';

const MEMORY_LAYER_PRED = 'http://dkg.io/ontology/memoryLayer';
const STATE_PRED = 'http://dkg.io/ontology/state';
const PUBLISHED_UAL_PRED = 'http://dkg.io/ontology/publishedUal';
const ASSERTION_GRAPH_PRED = 'http://dkg.io/ontology/assertionGraph';

export interface PublishedNamedKaVmLifecycleInput {
  readonly contextGraphId: string;
  readonly agentAddress: string;
  readonly name: string;
  readonly subGraphName?: string;
  readonly publishedUal: string;
  /** The chain-current root to materialize, which may supersede the queued root. */
  readonly merkleRoot: string;
  readonly packedKaId?: bigint;
  /** An update converges its owned WM pointer with VM; a replacement keeps its own pointer. */
  readonly convergeWorkingMemory?: boolean;
}

/** Canonical confirmed-chain bookkeeping, independent of the mutable draft owner. */
async function recordPublishedNamedKaVm(store: TripleStore, input: PublishedNamedKaVmLifecycleInput) {
  const assertionUri = contextGraphAssertionUri(
    input.contextGraphId,
    input.agentAddress,
    input.name,
    input.subGraphName,
  );
  const lifecycleUri = assertionLifecycleUri(
    input.contextGraphId,
    input.agentAddress,
    input.name,
    input.subGraphName,
  );
  const metaGraph = contextGraphMetaUri(input.contextGraphId);
  const bareMerkleRoot = input.merkleRoot.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(bareMerkleRoot)) {
    throw new Error(
      `Cannot stamp named KA VM lifecycle for "${input.name}": invalid merkle root ${input.merkleRoot}`,
    );
  }

  return withNamedKaVmMetadataLock(store, metaGraph, lifecycleUri, async () => {
    await deleteByPatternWithoutCount(store, { subject: lifecycleUri, predicate: VM_CURRENT_ASSERTION_PRED, graph: metaGraph });
    await store.insert([{
      subject: lifecycleUri,
      predicate: VM_CURRENT_ASSERTION_PRED,
      object: JSON.stringify(bareMerkleRoot),
      graph: metaGraph,
    }]);

    // #1104: reconcile the KA's dual identity. `dkg:reservedUal`
    // (chain/author/kaNumber, stamped at finalize) and the published
    // UAL (chain/contract/tokenId, returned by vm/publish) are both
    // permanent — record the published UAL on the lifecycle URN
    // (drop-then-set, so updates re-point to the latest published UAL).
    //
    // Merge note (PR #1107 ← main): #1095's separate `published`
    // prov:Activity EVENT minting was dropped here — main's RFC
    // ka-metadata-trim deliberately removed `generateAssertionPublishedMetadata`,
    // and main already stamps `dkg:state="published"` above (which
    // `deriveStatus` maps to `vm-confirmed`), so the lifecycle STATE fix
    // #1095 targeted is satisfied without the trimmed event entity.
    await deleteByPatternWithoutCount(store, { subject: lifecycleUri, predicate: PUBLISHED_UAL_PRED, graph: metaGraph });
    await store.insert([{
      subject: lifecycleUri,
      predicate: PUBLISHED_UAL_PRED,
      object: JSON.stringify(input.publishedUal),
      graph: metaGraph,
    }]);

    return { lifecycleUri, assertionUri, metaGraph };
  });
}

/** Idempotent materializer for callers already owning the draft lifecycle. */
export async function applyPublishedNamedKaVmLifecycle(store: TripleStore, input: PublishedNamedKaVmLifecycleInput): Promise<void> {
  const { lifecycleUri, assertionUri, metaGraph } = await recordPublishedNamedKaVm(store, input);
  await withNamedKaVmMetadataLock(store, metaGraph, lifecycleUri,
    () => applyPublishedNamedKaDraftLifecycle(store, input, lifecycleUri, assertionUri, metaGraph));
}

/** Confirmed VM bookkeeping survives a replacement; only its captured draft may transition. */
export async function applyOwnedPublishedNamedKaVmLifecycle(
  store: TripleStore, publisher: DKGPublisher, input: PublishedNamedKaVmLifecycleInput,
  expectedShareOperationId: string | null,
): Promise<void> {
  const { lifecycleUri, assertionUri, metaGraph } = await recordPublishedNamedKaVm(store, input);
  await publisher.withPublishedAssertionLifecycle(input.contextGraphId, input.name, input.agentAddress, expectedShareOperationId,
    () => withNamedKaVmMetadataLock(store, metaGraph, lifecycleUri,
      () => applyPublishedNamedKaDraftLifecycle(store, input, lifecycleUri, assertionUri, metaGraph)), input.subGraphName);
}

// These current-draft markers require the captured publication owner.
// OT-RFC-44 Design B — the assertion now lives at Verifiable Memory, so
// make its lifecycle marker match the on-chain reality: flip
// dkg:memoryLayer -> "VM" and dkg:state -> "published". The VM record is
// thus equivalent to the WM/SWM ones, with the extra transaction metadata
// (dkg:vmCurrentAssertion + dkg:kaId + the on-chain UAL) layered on top.
// Promote stamps memoryLayer "SWM" on BOTH the lifecycle-URN and the
// data-graph-URI forms, so flip both — otherwise the published assertion
// lingers in the Shared-Memory layer (the dedicated published-metadata
// flip never fired: its trigger gate joins on dkg:rootEntity/dkg:agent
// predicates the lifecycle record does not carry).
// SUBSTRATE-2 — re-point dkg:assertionGraph to the per-KA verifiable-
// memory graph this publish actually wrote
// (…/_verifiable_memory/{author}/{number}). promote() left the pointer on
// the SWM graph, which the post-confirm SWM cleanup then empties — so
// without this re-stamp the _meta index follows a stale pointer to an
// empty graph instead of the live VM data. Mirrors the wm→swm re-stamp
// in generateAssertionPromotedMetadata, for the swm→vm transition. The
// graph URI is derived from the minted kaId exactly as the data write
// (publishFromSharedMemory at dkg-publisher.ts: VerifiableMemory layer,
// {kaId>>96}, {kaId & 2^96-1}, subGraphName) derives it, so the pointer
// and the data always name the same graph.
//
// Gated on confirmed + onChainResult: that's the exact branch that ran
// the post-confirmation VM data write, so the graph is guaranteed to
// exist. A `tentative` publish (no on-chain result yet) hasn't written
// VM data, so we leave the pointer alone rather than aim it at a graph
// that doesn't exist yet.
// Derive the VM graph URI from the packed KA id (author<<96 | number)
// that named the …/_verifiable_memory/{author}/{number} graph. Prefer
// the finalize-reserved id we threaded down as `reservedKaId`, then an
// explicit on-chain `kaId` if the adapter reports one. Only fall back
// to `result.kaId` for legacy/no-chain shapes. Do NOT use
// `onChainResult.batchId`: on some adapters batchId is batch metadata,
// not the packed KA id.
// RFC ka-metadata-trim Phase 2 (corrected by adversarial review
// F4) — WM-graph marker flip at the VM transition.
// `assertionCreate` stamps `<wmGraph> dkg:memoryLayer "WM"` on the
// per-KA number-keyed WM graph URI (assertionPromote flips it in
// place to "SWM"). The flip above only covers the lifecycle URN
// and the legacy name-keyed assertion URI; the data-graph-URI
// marker would otherwise read "SWM" forever — misleading, since
// the data now lives at VM. We UPDATE it to "VM" rather than
// DELETE it: `assertAssertionDataPersisted` (dkg-publisher.ts)
// reads this exact row as its "already promoted → harmless no-op"
// witness, so deleting it would make a stale re-promote after a
// successful publish misfire AssertionNotPersistedError when the
// preserved extraction markers are present (Codex #898 case).
// Any non-"WM" value short-circuits that guard, so "VM" keeps the
// no-op witness AND tells the truth about the layer.
async function applyPublishedNamedKaDraftLifecycle(
  store: TripleStore, input: PublishedNamedKaVmLifecycleInput, lifecycleUri: string, assertionUri: string, metaGraph: string,
): Promise<void> {
  if (input.convergeWorkingMemory) {
    await stampLifecyclePointerIfDivergedFromVm(
      store, lifecycleUri, WM_CURRENT_ASSERTION_PRED, input.merkleRoot.toLowerCase().replace(/^0x/, ''), metaGraph,
    );
  }
  const lifecycleReplacements = [
    { subject: lifecycleUri, predicate: MEMORY_LAYER_PRED, object: `"${MemoryLayer.VerifiableMemory}"`, graph: metaGraph },
    { subject: lifecycleUri, predicate: STATE_PRED, object: '"published"', graph: metaGraph },
  ];
  if (input.packedKaId === undefined) {
    await replaceNamedKaVmDraftSubject(store, metaGraph, lifecycleUri, lifecycleReplacements);
    await replaceNamedKaVmDraftSubject(store, metaGraph, assertionUri, [{
      subject: assertionUri, predicate: MEMORY_LAYER_PRED, object: `"${MemoryLayer.VerifiableMemory}"`, graph: metaGraph,
    }]);
    return;
  }
  const vmAuthor = `0x${(input.packedKaId >> 96n).toString(16).padStart(40, '0')}`;
  const vmNumber = input.packedKaId & ((1n << 96n) - 1n);
  const vmGraph = contextGraphLayerUri(
    input.contextGraphId,
    MemoryLayer.VerifiableMemory,
    vmAuthor,
    vmNumber,
    input.subGraphName,
  );
  lifecycleReplacements.push({ subject: lifecycleUri, predicate: ASSERTION_GRAPH_PRED, object: vmGraph, graph: metaGraph });
  await replaceNamedKaVmDraftSubject(store, metaGraph, lifecycleUri, lifecycleReplacements);
  await replaceNamedKaVmDraftSubject(store, metaGraph, assertionUri, [{
    subject: assertionUri, predicate: MEMORY_LAYER_PRED, object: `"${MemoryLayer.VerifiableMemory}"`, graph: metaGraph,
  }]);

  const wmGraph = contextGraphLayerUri(
    input.contextGraphId,
    MemoryLayer.WorkingMemory,
    vmAuthor,
    vmNumber,
    input.subGraphName,
  );
  await replaceNamedKaVmDraftSubject(store, metaGraph, wmGraph, [{
    subject: wmGraph, predicate: MEMORY_LAYER_PRED, object: `"${MemoryLayer.VerifiableMemory}"`, graph: metaGraph,
  }]);
}

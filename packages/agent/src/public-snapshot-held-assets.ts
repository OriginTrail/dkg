// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import type { AcceptedPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { contextGraphMetaUri, parseDeterministicKnowledgeAssetUal } from '@origintrail-official/dkg-core';
import { readConfirmedGraphKnowledgeAssetMetadataEnvelope } from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { resolveConfirmedGraphScopedVm, resolveLocallyConfirmedGraphScopedVm } from './confirmed-graph-scoped-vm-resolver.js';
import { packKnowledgeAssetIdFromIdentity } from './ka-identity.js';
import type { PublicSnapshotMode } from './public-snapshot-mode.js';

/**
 * Whether this node already holds a snapshot asset: a confirmed graph-scoped
 * copy at the pinned version and root whose stored content still verifies
 * against that root, or a newer confirmed version whose own content verifies
 * against the root it was confirmed at. That is the rule a catch-up uses to
 * count content as held; an older snapshot never replaces a newer stored
 * version, so such an asset could not be imported anyway. Chain reconciliation
 * and inbox replay recognise a confirmed copy with the same resolver. A held
 * asset needs no transfer, so a job that was stopped part-way, or a batch that
 * is retried, continues where the store stands.
 *
 * Skipping never changes what is stored: the copy keeps the evidence labels it
 * was stored with. An `rpc-only` job therefore still imports a copy at the
 * pinned version that is labelled with core-cache evidence, which relabels it
 * with its own independent evidence as before. Any read failure answers false,
 * and the asset is fetched as before.
 */
export function createPublicSnapshotHeldAssetCheck(
  store: TripleStore,
  observation: { readonly snapshot: AcceptedPublicGraphSnapshot; readonly mode: PublicSnapshotMode },
): (ual: string) => Promise<boolean> {
  const { snapshot, mode } = observation;
  const pins = new Map(snapshot.assets.map(asset => [asset.id, asset]));
  const contextGraphId = snapshot.contextGraphId;
  return async (ual) => {
    try {
      const kaId = packKnowledgeAssetIdFromIdentity(parseDeterministicKnowledgeAssetUal(ual));
      const pin = pins.get(kaId.toString());
      if (!pin) return false;
      const stored = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, { contextGraphId, ual });
      if (stored.state !== 'confirmed') return false;
      const storedVersion = BigInt(stored.envelope.assertionVersion);
      const copy = { contextGraphId, ual, kaId, batchId: kaId,
        ...(stored.envelope.subGraphName === undefined ? {} : { subGraphName: stored.envelope.subGraphName }) };
      if (storedVersion > BigInt(pin.version)) {
        const newer = await resolveLocallyConfirmedGraphScopedVm(store, { ...copy, assertionVersion: storedVersion });
        return newer.status === 'verified';
      }
      if (mode === 'rpc-only' && await labelledCoreCache(store, contextGraphId, ual)) return false;
      const held = await resolveConfirmedGraphScopedVm(store, {
        ...copy, assertionVersion: BigInt(pin.version), merkleRoot: ethers.getBytes(pin.root),
      });
      return held.status === 'verified';
    } catch {
      return false;
    }
  };
}

async function labelledCoreCache(store: TripleStore, contextGraphId: string, ual: string): Promise<boolean> {
  const result = await store.query(
    `ASK { GRAPH <${contextGraphMetaUri(contextGraphId)}> { <${ual}> <http://dkg.io/ontology/chainEvidenceMode> "core-cache" } }`,
  );
  return result.type !== 'boolean' || result.value;
}

// SPDX-License-Identifier: Apache-2.0
import { nonEmptyNamedGraphEnumerationPattern, type TripleStore } from '@origintrail-official/dkg-storage';
import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { verifyExactGraphContent } from './exact-graph-content-verifier.js';
import { assertPublicSnapshotQueryTrust } from './public-snapshot-evidence.js';
import type { SnapshotCheckpointManifest, SnapshotCheckpointAudit } from './snapshot-checkpoint-contract.js';
import { stripMetadataLiteral } from './sync/metadata-literal.js';

/** Full journal readback, including the durable trust guard. Sampling is not coverage. */
export async function auditSnapshotCheckpoint(store: TripleStore,
  manifest: SnapshotCheckpointManifest, signal: AbortSignal): Promise<SnapshotCheckpointAudit> {
  const { snapshot } = manifest.observation;
  const deadline = (ms: number) => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]) });
  const rows = await store.query(`SELECT ?ual ?root ?version WHERE { GRAPH <${contextGraphMetaUri(snapshot.contextGraphId)}> {
    ?ual <http://dkg.io/ontology/merkleRoot> ?root; <http://dkg.io/ontology/assertionVersion> ?version
  } } LIMIT ${manifest.assets.length + 1}`, deadline(30_000));
  if (rows.type !== 'bindings' || rows.bindings.length !== manifest.assets.length) throw new Error('Checkpoint metadata coverage mismatch');
  const byUal = new Map(rows.bindings.map(row => [row.ual, row]));
  for (const asset of manifest.assets) {
    signal.throwIfAborted();
    const row = byUal.get(asset.ual);
    if (!row || stripMetadataLiteral(row.root!).replace(/^0x/, '') !== asset.root.replace(/^0x/, '')
      || BigInt(stripMetadataLiteral(row.version!)) !== BigInt(asset.version)) throw new Error('Checkpoint identity or version mismatch');
    const checked = await verifyExactGraphContent(store, { graphUri: asset.graph, publicTripleCount: asset.publicQuads,
      expectedMerkleRoot: Buffer.from(asset.root.replace(/^0x/, ''), 'hex'),
      source: 'publicCheckpoint.readback', queryOptions: deadline(30_000) });
    if (checked.status !== 'verified') throw new Error(`Checkpoint readback failed: ${checked.status}`);
  }
  // Each asset's exact count and root were read back above. The remaining proof
  // is that no other nonempty public graph exists, not another scan of every quad.
  const publicGraphs = new Set(manifest.assets.map(asset => asset.graph));
  const reserved = [contextGraphMetaUri(snapshot.contextGraphId), 'urn:dkg:local:public-snapshot-trust'];
  const expected = new Set(manifest.assets.filter(asset => asset.publicQuads > 0).map(asset => asset.graph));
  const allowed = new Set([...expected, ...reserved]);
  const graphs = await store.query(`SELECT ?g WHERE { ${nonEmptyNamedGraphEnumerationPattern()} } LIMIT ${allowed.size + 1}`, deadline(30_000));
  if (publicGraphs.size !== manifest.assets.length || reserved.some(graph => publicGraphs.has(graph)) || graphs.type !== 'bindings')
    throw new Error('Checkpoint total coverage mismatch');
  const actual = new Set(graphs.bindings.map(row => row.g));
  if (actual.size !== graphs.bindings.length || [...actual].some(graph => !graph || !allowed.has(graph))
    || [...expected].some(graph => !actual.has(graph)))
    throw new Error('Checkpoint total coverage mismatch');
  const positive = await store.query(`ASK { GRAPH <${manifest.assets[0]!.graph}> { ?s ?p ?o } }`, deadline(2_000));
  const negative = await store.query('ASK { GRAPH <urn:dkg:checkpoint:absent> { ?s ?p ?o } }', deadline(2_000));
  if (positive.type !== 'boolean' || !positive.value || negative.type !== 'boolean' || negative.value) throw new Error('Checkpoint bounded query failed');
  if (manifest.observation.mode === 'core-cache') {
    let refused = false;
    try { await assertPublicSnapshotQueryTrust(store, snapshot.contextGraphId, undefined, deadline(2_000)); }
    catch (error) { if ((error as { code?: string }).code !== 'CORE_CACHE_QUERY_TRUST_REQUIRED') throw error; refused = true; }
    if (!refused) throw new Error('Checkpoint trust guard missing');
  }
  return { assets: manifest.assets.length, publicQuads: manifest.assets.reduce((n, a) => n + a.publicQuads, 0), fullReadback: true };
}

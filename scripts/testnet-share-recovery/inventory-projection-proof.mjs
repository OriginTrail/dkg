import { encodeCanonicalCgSharedPublicRootProjectionV1, computeKaProjectionDigestV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1, encodeOpaqueKaBundleV1, computeKaChunkTreeRootV1,
  KA_TRANSFER_CHUNK_SIZE_V1, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer } from '../../packages/core/dist/index.js';
import { computeFlatKCRootV10 } from '../../packages/publisher/dist/index.js';
import { bindingTermIdentity } from './rdf-term-identity.mjs';

const term = value => {
  const [kind, text, datatype, language] = bindingTermIdentity(value);
  if (kind === 'uri') return text;
  if (kind === 'bnode') return '_:' + text;
  return JSON.stringify(text) + (language ? '@' + language : datatype === 'http://www.w3.org/2001/XMLSchema#string' ? '' : `^^<${datatype}>`);
};

export function projectionCommitments(seal, quads) {
  if (seal.privateTripleCount !== '0') throw Error('This public-payload campaign does not capture private projection commitments');
  if (BigInt(quads.length) !== BigInt(seal.publicTripleCount)) throw Error('Captured payload count differs from original seal');
  const root = '0x' + Buffer.from(computeFlatKCRootV10(quads, [])).toString('hex');
  if (root !== seal.assertionMerkleRoot) throw Error('Captured payload root differs from original seal');
  const projection = encodeCanonicalCgSharedPublicRootProjectionV1(quads);
  const bundle = encodeOpaqueKaBundleV1(projection, canonicalizeCanonicalGraphScopedAuthorSealBytesV1(seal));
  return { projectionDigest: computeKaProjectionDigestV1(projection), transfer: {
    codec: 'dkg-ka-bundle-v1', projectionId: 'cg-shared-v1', projectionDigest: bundle.projectionDigest,
    byteLength: String(bundle.bundleBytes.byteLength), chunkSize: KA_TRANSFER_CHUNK_SIZE_V1,
    chunkCount: String((BigInt(bundle.bundleBytes.byteLength) + BigInt(KA_TRANSFER_CHUNK_SIZE_V1) - 1n) / BigInt(KA_TRANSFER_CHUNK_SIZE_V1)),
    blobDigest: bundle.blobDigest, chunkTreeRoot: computeKaChunkTreeRootV1(bundle.bundleBytes),
  } };
}

/** Bind independently committed rows to the original seal and captured public payload. */
export function verifyInventoryProjections(campaign, expected, inventory, catalogs, rdf) {
  const errors = [], missingInventory = [], missingCatalog = [], assets = [];
  for (const { name, seal } of expected) {
    const inv = inventory.filter(r => r.assertion_coordinate === name), cat = catalogs.filter(r => r.assertionCoordinate === name);
    if (!inv.length) missingInventory.push(name);
    if (!cat.length) missingCatalog.push(name);
    if (!inv.length && !cat.length) continue; // Keep baseline incompleteness; no projection is certified for absent rows.
    try {
      if (inv.length > 1 || cat.length > 1) throw Error('Duplicate projection identity');
      const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
      const graphs = [MemoryLayer.SharedWorkingMemory, MemoryLayer.VerifiableMemory].map(layer => knowledgeAssetLayerGraphUri(campaign.contextGraphId, layer, scope));
      const payloads = graphs.map(graph => rdf.filter(r => r.g.type === 'uri' && r.g.value === graph)).filter(rows => rows.length);
      if (!payloads.length) throw Error('Missing captured committed payload');
      let commitment;
      for (const rows of payloads) {
        const current = projectionCommitments(seal, rows.map(r => ({ subject: term(r.s), predicate: term(r.p), object: term(r.o), graph: '' })));
        if (commitment && JSON.stringify(commitment) !== JSON.stringify(current)) throw Error('Committed payload copies differ');
        commitment = current;
      }
      if (inv.length && (BigInt(inv[0].public_triple_count_u64be) !== BigInt(seal.publicTripleCount)
        || BigInt(inv[0].private_triple_count_u64be) !== BigInt(seal.privateTripleCount)
        || inv[0].projection_digest !== commitment.projectionDigest)) throw Error('Inventory projection/counts differ from original sealed payload');
      if (cat.length && (cat[0].projectionId !== 'cg-shared-v1' || cat[0].projectionDigest !== commitment.projectionDigest
        || Object.entries(commitment.transfer).some(([key, value]) => cat[0].transfer?.[key] !== value))) throw Error('Catalog projection/transfer differs from original sealed payload');
      assets.push({ name, projectionDigest: commitment.projectionDigest, transferVerified: cat.length === 1 });
    } catch (error) { errors.push({ name, message: error.message }); }
  }
  return { consistent: !errors.length, exactInventory: !errors.length && !missingInventory.length,
    exactCatalog: !errors.length && !missingCatalog.length, errors, missingInventory, missingCatalog, assets };
}

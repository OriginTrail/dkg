import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import type { PrivateContentStore, TripleStore } from '@origintrail-official/dkg-storage';
import { readConfirmedGraphKnowledgeAssetMetadataEnvelope } from './metadata.js';
import { computePrivateRootV10 } from './merkle.js';

/** Read one confirmed version, never a mutable draft or a neighboring KA. Caller owns authorization. */
export async function readConfirmedPrivateKnowledgeAsset(
  store: TripleStore,
  privateStore: PrivateContentStore,
  contextGraphId: string,
  ual: string,
  subGraphName?: string,
) {
  const metadata = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, { contextGraphId, ual });
  if (metadata.state !== 'confirmed') {
    throw Object.assign(new Error('Confirmed private KA metadata is unavailable or invalid.'), {
      code: 'PRIVATE_KA_METADATA_UNAVAILABLE',
    });
  }
  const envelope = metadata.envelope;
  if (envelope.subGraphName !== subGraphName) {
    throw Object.assign(new Error('Confirmed KA does not belong to the requested subgraph.'), {
      code: 'PRIVATE_KA_SCOPE_MISMATCH',
    });
  }
  const scope = createGraphKnowledgeAssetScope(ual, envelope.assertionVersion);
  const quads = await privateStore.getKnowledgeAssetPrivateTriples(contextGraphId, scope, subGraphName);
  const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString('hex')}`;
  if (quads.length !== envelope.privateTripleCount || (quads.length > 0
    && hex(computePrivateRootV10(quads)!) !== hex(envelope.privateMerkleRoot!))) {
    throw Object.assign(new Error('Private KA payload does not match its confirmed commitment.'), {
      code: 'PRIVATE_KA_PAYLOAD_MISMATCH',
    });
  }
  return {
    status: 'vm-confirmed' as const,
    ual: scope.ual,
    assertionVersion: scope.assertionVersion,
    privateTripleCount: envelope.privateTripleCount,
    ...(envelope.privateMerkleRoot ? { privateMerkleRoot: hex(envelope.privateMerkleRoot) } : {}),
    merkleRoot: hex(envelope.merkleRoot),
    ...(envelope.transactionHash ? { transactionHash: envelope.transactionHash } : {}),
    quads: quads.map(quad => ({ ...quad, graph: '' })),
    count: quads.length,
  };
}

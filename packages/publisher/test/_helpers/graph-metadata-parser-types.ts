import type { Quad } from '@origintrail-official/dkg-storage';
import { parseGraphKnowledgeAssetMetadataEnvelope, parseStoredGraphKnowledgeAssetMetadataEnvelope,
  parseWireGraphKnowledgeAssetStructure } from '../../src/index.js';

export function assertParserBoundaries(rows: Pick<Quad, 'predicate' | 'object'>[], routed: Quad[]): void {
  const input = { ual: 'did:dkg:hardhat:0xab/7', contextGraphId: 'example' };
  parseWireGraphKnowledgeAssetStructure(routed, input.ual);
  parseStoredGraphKnowledgeAssetMetadataEnvelope(routed, input);
  parseGraphKnowledgeAssetMetadataEnvelope(rows, input);
  // @ts-expect-error Wire admission requires the named graph on every row.
  parseWireGraphKnowledgeAssetStructure(rows, input.ual);
  // @ts-expect-error Stored admission requires the named graph on every row.
  parseStoredGraphKnowledgeAssetMetadataEnvelope(rows, input);
  // @ts-expect-error Stored admission requires the requested context.
  parseStoredGraphKnowledgeAssetMetadataEnvelope(routed, { ual: input.ual });
  // @ts-expect-error Projected readers must supply the trusted context.
  parseGraphKnowledgeAssetMetadataEnvelope(rows, { ual: input.ual });
}

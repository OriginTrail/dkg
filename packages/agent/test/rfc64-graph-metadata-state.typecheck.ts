import {
  generateGraphKnowledgeAssetMetadata,
  type GraphKnowledgeAssetConfirmation,
  type GraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';

declare const meta: GraphKnowledgeAssetMetadata;
declare const confirmation: GraphKnowledgeAssetConfirmation;

generateGraphKnowledgeAssetMetadata(meta, { status: 'tentative' });
generateGraphKnowledgeAssetMetadata(meta, { status: 'confirmed', confirmation });

// @ts-expect-error confirmed metadata cannot omit provenance
generateGraphKnowledgeAssetMetadata(meta, { status: 'confirmed' });

// @ts-expect-error tentative metadata cannot carry confirmation provenance
generateGraphKnowledgeAssetMetadata(meta, { status: 'tentative', confirmation });

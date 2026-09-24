import type {
  KnowledgeAssetReadModel, KnowledgeAssetReadModelFactory, ScalarKnowledgeAssetReadModel,
} from '../src/chain-index/knowledge-asset-read-model.js';
import type { ChainEventLogBinding } from '../src/chain-event-log-binding.js';

const legacy: KnowledgeAssetReadModel = {
  async readContextGraphForKa() { return undefined; },
  async readContextGraphKaList() { return undefined; },
};
// @ts-expect-error A modern owned reader factory must supply the scalar ordinal port.
const invalidFactory: KnowledgeAssetReadModelFactory = () => legacy;
// Explicit legacy bindings still accept list-only readers for attachment/source normalization.
const legacyAttachment: Pick<ChainEventLogBinding, 'knowledgeAssets'> = { knowledgeAssets: legacy };
const modern: ScalarKnowledgeAssetReadModel = {
  ...legacy,
  async readContextGraphKaAt() { return undefined; },
};
const factory: KnowledgeAssetReadModelFactory = () => modern;
void [invalidFactory, legacyAttachment, factory];

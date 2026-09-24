// SPDX-License-Identifier: Apache-2.0

import type { ChainEventLogBinding } from './chain-event-log-binding.js';
import {
  isScalarKnowledgeAssetReadModel,
  normalizeKnowledgeAssetReadModel,
  type ScalarKnowledgeAssetReadModel,
} from './chain-index/normalize-knowledge-asset-read-model.js';

const legacyReaders = new WeakMap<ChainEventLogBinding, ScalarKnowledgeAssetReadModel>();

/** Adapt only a legacy reader; the original binding remains the generation token. */
export function knowledgeAssetReaderForBinding(
  binding: ChainEventLogBinding | undefined,
): ScalarKnowledgeAssetReadModel | undefined {
  const reader = binding?.knowledgeAssets;
  if (binding === undefined || reader === undefined) return undefined;
  if (isScalarKnowledgeAssetReadModel(reader)) return reader;
  const existing = legacyReaders.get(binding);
  if (existing !== undefined) return existing;
  const normalized = normalizeKnowledgeAssetReadModel(reader);
  legacyReaders.set(binding, normalized);
  return normalized;
}

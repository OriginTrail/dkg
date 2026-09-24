// SPDX-License-Identifier: Apache-2.0

import type { ChainEventLogBinding } from './chain-event-log-binding.js';
import {
  isScalarKnowledgeAssetReadModel,
  normalizeKnowledgeAssetReadModel,
  type ScalarKnowledgeAssetReadModel,
} from './chain-index/normalize-knowledge-asset-read-model.js';

/** The adapter's internal binding; public attachment inputs retain legacy support. */
export interface NormalizedChainEventLogBinding extends Omit<ChainEventLogBinding, 'knowledgeAssets'> {
  readonly knowledgeAssets?: ScalarKnowledgeAssetReadModel;
}

const normalizedBindings = new WeakMap<ChainEventLogBinding, NormalizedChainEventLogBinding>();

function isNormalizedBinding(binding: ChainEventLogBinding): binding is NormalizedChainEventLogBinding {
  return binding.knowledgeAssets === undefined || isScalarKnowledgeAssetReadModel(binding.knowledgeAssets);
}

/** Keep a stable generation token when a borrowed legacy binding needs adapting. */
export function normalizeChainEventLogBinding(
  binding: ChainEventLogBinding | undefined,
): NormalizedChainEventLogBinding | undefined {
  if (binding === undefined) return undefined;
  const existing = normalizedBindings.get(binding);
  if (existing !== undefined) return existing;
  if (isNormalizedBinding(binding)) {
    normalizedBindings.set(binding, binding);
    return binding;
  }
  const normalized = Object.freeze({
    // Read the interface explicitly: SDK bindings may expose these values
    // through prototype getters, which an object spread would silently drop.
    scope: binding.scope,
    subscription: binding.subscription,
    contextGraphAuthority: binding.contextGraphAuthority,
    contextGraphStorageAddress: binding.contextGraphStorageAddress,
    knowledgeAssetStorageAddress: binding.knowledgeAssetStorageAddress,
    knowledgeAssets: normalizeKnowledgeAssetReadModel(binding.knowledgeAssets!),
    ...(binding.readEventScanLease === undefined ? {} : {
      readEventScanLease: binding.readEventScanLease.bind(binding),
    }),
    ...(binding.readHubRotationWindow === undefined ? {} : {
      readHubRotationWindow: binding.readHubRotationWindow.bind(binding),
    }),
  });
  normalizedBindings.set(binding, normalized);
  return normalized;
}

// SPDX-License-Identifier: Apache-2.0

import type { TripleStore } from '@origintrail-official/dkg-storage';

import type { ResolvedRfc64CatalogRolloutConfigV1 } from
  './catalog-rollout-authority-v1.js';
import {
  createRfc64DurableFileStoreV1,
  type Rfc64DurableFileStoreV1,
} from './durable-file-store-v1.js';
import type { Rfc64PersistenceV1 } from './persistence-v1.js';
import {
  deactivateRfc64AppliedCatalogAuthorityV1,
  readRfc64AppliedCatalogContextGraphIdV1,
} from './public-catalog-native-receiver-v1.js';

const STATE_RELATIVE_PATH_V1 = 'rollout-authority-v1/state.json';
const MAX_STATE_BYTES_V1 = 64 * 1024;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

interface StoredRfc64CatalogAuthorityV1 {
  readonly version: 1;
  readonly catalogContextGraphs: readonly string[];
}

/**
 * Reconcile the operator plan with actual durable catalog authority before any
 * network worker starts. An absent sidecar is never treated as proof of an
 * empty catalog: every applied head is inspected and any graph leaving catalog
 * mode is semantically deactivated before its durable applied ref is removed.
 */
export async function persistRfc64CatalogAuthorityPlanV1(
  persistence: Rfc64PersistenceV1,
  store: TripleStore,
  activation: Readonly<{
    readonly enabled: boolean;
    readonly selectedContextGraphs: readonly string[];
    readonly rollout: ResolvedRfc64CatalogRolloutConfigV1;
  }>,
): Promise<void> {
  const durableFiles = createRfc64DurableFileStoreV1<'authority-state'>(
    persistence.rootPath,
  );
  // Parse the prior record even though durable inventory owns migration truth:
  // malformed restart-critical state must fail closed rather than be replaced.
  await readStoredPlanV1(durableFiles);

  const selectedCatalogGraphs = activation.selectedContextGraphs.filter(
    (contextGraphId) => activation.rollout.contextGraphModes[contextGraphId] === 'catalog',
  );
  const nextCatalogSet = new Set(selectedCatalogGraphs);
  for (const appliedHead of persistence.inventory.listAppliedCatalogHeadsV1()) {
    const contextGraphId = await readRfc64AppliedCatalogContextGraphIdV1({
      controlObjects: persistence.controlObjects,
      appliedHead,
    });
    // The activation resolver deliberately preserves the pre-activation
    // standalone catalog API when no selected-CG rollout block is enabled.
    // Existing durable catalog authority is part of that compatibility
    // contract, so an absent new activation must never erase it merely because
    // it cannot name the graph in a rollout manifest.
    if (!activation.enabled) nextCatalogSet.add(contextGraphId);
    if (nextCatalogSet.has(contextGraphId)) continue;
    await deactivateRfc64AppliedCatalogAuthorityV1({
      store,
      controlObjects: persistence.controlObjects,
      inventory: persistence.inventory,
      appliedHead,
    });
  }

  const nextCatalogGraphs = Object.freeze([...nextCatalogSet].sort());
  const plan: StoredRfc64CatalogAuthorityV1 = Object.freeze({
    version: 1,
    catalogContextGraphs: nextCatalogGraphs,
  });
  await durableFiles.replaceExactBytes({
    relativePath: STATE_RELATIVE_PATH_V1,
    bytes: UTF8_ENCODER.encode(`${JSON.stringify(plan)}\n`),
    maxBytes: MAX_STATE_BYTES_V1,
    label: 'RFC-64 catalog authority state',
    kind: 'authority-state',
  });
}

async function readStoredPlanV1(
  durableFiles: Rfc64DurableFileStoreV1<'authority-state'>,
): Promise<StoredRfc64CatalogAuthorityV1 | null> {
  const bytes = await durableFiles.readOptionalBoundedBytes({
    relativePath: STATE_RELATIVE_PATH_V1,
    maxBytes: MAX_STATE_BYTES_V1,
    label: 'RFC-64 catalog authority state',
  });
  if (bytes === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (error) {
    throw new Error('RFC-64 catalog authority state is not valid JSON', { cause: error });
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || (parsed as { version?: unknown }).version !== 1
    || !Array.isArray((parsed as { catalogContextGraphs?: unknown }).catalogContextGraphs)
    || (parsed as { catalogContextGraphs: unknown[] }).catalogContextGraphs.some(
      (value) => typeof value !== 'string' || value.length === 0,
    )
  ) throw new Error('RFC-64 catalog authority state is malformed');
  const catalogContextGraphs = (parsed as { catalogContextGraphs: string[] })
    .catalogContextGraphs;
  if (new Set(catalogContextGraphs).size !== catalogContextGraphs.length) {
    throw new Error('RFC-64 catalog authority state contains duplicate CGs');
  }
  return Object.freeze({
    version: 1,
    catalogContextGraphs: Object.freeze([...catalogContextGraphs]),
  });
}

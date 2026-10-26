// SPDX-License-Identifier: Apache-2.0
import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import type { StoreContentFence } from '../../internal/store-content-fence.js';
import type { HeldGraphScopedAssetsRequest } from './stored-graph-assets.js';
import { graphScopedDurableManifestPrefixAtOffset, type GraphScopedDurableManifestPlan } from '../durable-integrity.js';

export interface StoredDurablePrefix {
  read(request: HeldGraphScopedAssetsRequest): Promise<ReadonlySet<string>>;
  readonly openScope: StoreContentFence['openScope'];
  assertCurrent(): void;
}

/** A checkpoint proves past writes, not present contents. Retain a content watch
 * from before reading the skipped prefix until the caller settles its suffix.
 */
export async function proveStoredDurablePrefix(
  capability: StoredDurablePrefix | undefined,
  manifest: GraphScopedDurableManifestPlan,
  offset: number,
  signal?: AbortSignal,
): Promise<{ assertCurrent(): void; close(): void }> {
  const prefix = graphScopedDurableManifestPrefixAtOffset(manifest, offset);
  if (!prefix || !capability) throw new Error('Cannot prove stored durable prefix');
  const descriptors = manifest.descriptors.slice(0, prefix.descriptorCount);
  const proof = capability.openScope({
    assertionGraphs: descriptors.map(descriptor => descriptor.assertionGraph),
    metadataGraph: contextGraphMetaUri(manifest.contextGraphId), subjects: descriptors.map(descriptor => descriptor.ual),
  });
  if (!proof) throw new Error('Cannot prove stored durable prefix');
  const assertCurrent = () => { capability.assertCurrent(); proof.assertCurrent(); signal?.throwIfAborted(); };
  try {
    assertCurrent();
    const held = await capability.read({ contextGraphId: manifest.contextGraphId, descriptors, signal });
    assertCurrent();
    if (descriptors.some(descriptor => !held.has(descriptor.ual))) throw new Error('Stored durable prefix is missing or corrupt');
    return { assertCurrent, close: proof.close };
  } catch (error) { proof.close(); throw error; }
}

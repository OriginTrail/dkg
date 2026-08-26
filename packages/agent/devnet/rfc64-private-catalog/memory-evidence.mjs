// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

import {
  quadsToNQuads,
  readExactGraphPagedWithDiscoveredCount,
} from '@origintrail-official/dkg-storage';

const DEFAULT_MAX_QUAD_COUNT = 16;
const DEFAULT_MAX_NQUADS_BYTES = 64 * 1024;

/**
 * Read one exact graph through the same bounded path used by the release gate
 * and return its canonical, graph-name-independent fingerprint.
 */
export async function readExactGraphMemoryEvidence(store, graph, options = {}) {
  const quads = await readExactGraphPagedWithDiscoveredCount(store, graph, {
    maxQuadCount: options.maxQuadCount ?? DEFAULT_MAX_QUAD_COUNT,
    maxNQuadsBytes: options.maxNQuadsBytes ?? DEFAULT_MAX_NQUADS_BYTES,
    outputGraph: '',
  });
  const canonicalNQuads = quadsToNQuads(quads).split('\n').sort().join('\n');
  return Object.freeze({
    count: quads.length,
    digest: createHash('sha256').update(canonicalNQuads, 'utf8').digest('hex'),
  });
}

/**
 * Validate the flattened process evidence against one explicit fixture model.
 * Asset and statement cardinalities are supplied by the fixture rather than
 * duplicated as magic numbers in the executable runner.
 */
export function hasExactPrivateCatalogMemoryContents(state, expected) {
  if (!Array.isArray(state?.graphCounts) || !Array.isArray(expected?.assetNumbers)) {
    return false;
  }
  const expectedAssets = new Set(expected.assetNumbers);
  const actualAssets = new Set(state.graphCounts.map(({ kaNumber }) => kaNumber));
  if (
    state.graphCounts.length !== expectedAssets.size
    || actualAssets.size !== expectedAssets.size
    || [...expectedAssets].some((kaNumber) => !actualAssets.has(kaNumber))
  ) {
    return false;
  }
  const projection = expected.projection;
  return state.graphCounts.every(({ swm, swmDigest, vm, vmDigest }) => (
    swm === projection?.count
    && vm === projection?.count
    && swmDigest === projection?.digest
    && vmDigest === projection?.digest
  ));
}

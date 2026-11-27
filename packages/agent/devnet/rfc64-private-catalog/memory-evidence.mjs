// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

import {
  MemoryLayer,
  contextGraphLayerUri,
} from '@origintrail-official/dkg-core';
import {
  quadsToNQuads,
  readExactGraphPagedWithDiscoveredCount,
} from '@origintrail-official/dkg-storage';

const DEFAULT_MAX_QUAD_COUNT = 16;
const DEFAULT_MAX_NQUADS_BYTES = 64 * 1024;

/** Canonical graph-name-independent serialization for one projection model. */
export function canonicalGraphlessProjectionNQuads(quads) {
  return quadsToNQuads(quads.map(({ subject, predicate, object }) => ({
    subject,
    predicate,
    object,
    graph: '',
  }))).split('\n').sort().join('\n');
}

/** Pure projection evidence shared by fixture construction and store reads. */
export function computeGraphlessMemoryEvidence(quads) {
  const canonicalNQuads = canonicalGraphlessProjectionNQuads(quads);
  return Object.freeze({
    count: quads.length,
    digest: createHash('sha256').update(canonicalNQuads, 'utf8').digest('hex'),
  });
}

/** Bind the canonical graphless fixture projection to one concrete memory graph. */
export function bindGraphlessProjectionToGraph(quads, graph) {
  return quads.map(({ subject, predicate, object }) => ({
    subject,
    predicate,
    object,
    graph,
  }));
}

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
  return computeGraphlessMemoryEvidence(quads);
}

/**
 * Construct the flattened per-asset evidence emitted by the release-gate
 * child. Each asset and both of its memory projections are independent, so all
 * bounded graph reads begin together while the returned order stays stable.
 */
export async function readPrivateCatalogGraphCountEvidence(store, input) {
  return Promise.all(input.assetNumbers.map(async (kaNumber) => {
    const swmGraph = contextGraphLayerUri(
      input.contextGraphId,
      MemoryLayer.SharedWorkingMemory,
      input.authorAddress,
      kaNumber,
    );
    const vmGraph = contextGraphLayerUri(
      input.contextGraphId,
      MemoryLayer.VerifiableMemory,
      input.authorAddress,
      kaNumber,
    );
    const [swm, vm] = await Promise.all([
      readExactGraphMemoryEvidence(store, swmGraph),
      readExactGraphMemoryEvidence(store, vmGraph),
    ]);
    return Object.freeze({
      kaNumber,
      swm: swm.count,
      swmDigest: swm.digest,
      vm: vm.count,
      vmDigest: vm.digest,
    });
  }));
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

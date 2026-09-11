// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

import {
  MemoryLayer,
  contextGraphLayerUri,
  contextGraphMetaUri,
  contextGraphWorkspaceMetaGraphUri,
  parseRenderedRdfStoreObjectV1,
} from '@origintrail-official/dkg-core';
import {
  quadsToNQuads,
  readExactGraphPagedWithDiscoveredCount,
} from '@origintrail-official/dkg-storage';
import { readVerifiedCatalogRowSwmProofV1 } from './verified-catalog-swm-proof.mjs';

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
  assertPrivateCatalogEvidenceInput(input);
  return Promise.all(input.assetNumbers.map(async (kaNumber) => {
    const kaUal = `did:dkg:${input.networkId}/${input.authorAddress}/${kaNumber}`;
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
    const [swm, vm, swmHead, vmHead] = await Promise.all([
      readExactGraphMemoryEvidence(store, swmGraph),
      readExactGraphMemoryEvidence(store, vmGraph),
      readLayerHeadEvidence(store, {
        graph: contextGraphWorkspaceMetaGraphUri(input.contextGraphId),
        subject: `${kaUal}#dkg-swm-head`,
        includeShareOperationId: true,
      }),
      readLayerHeadEvidence(store, {
        graph: contextGraphMetaUri(input.contextGraphId),
        subject: kaUal,
        includeShareOperationId: false,
      }),
    ]);
    const swmProof = input.swmProofMode === 'workspace-head'
      ? workspaceHeadProofV1(swmHead)
      : catalogRowProofV1(input, kaNumber);
    return Object.freeze({
      kaNumber,
      kaUal,
      swmGraph,
      swm: swm.count,
      swmDigest: swm.digest,
      swmProof,
      vmGraph,
      vm: vm.count,
      vmDigest: vm.digest,
      vmHead,
    });
  }));
}

function workspaceHeadProofV1(head) {
  return head === null
    ? Object.freeze({ kind: 'absent' })
    : Object.freeze({ kind: 'workspace-head', ...head });
}

function catalogRowProofV1(input, kaNumber) {
  return readVerifiedCatalogRowSwmProofV1(input.catalogClosure, kaNumber);
}

async function readLayerHeadEvidence(store, input) {
  const shareOperationSelection = input.includeShareOperationId
    ? '?shareOperationId'
    : '';
  const shareOperationPattern = input.includeShareOperationId
    ? `<${input.subject}> <http://dkg.io/ontology/shareOperationId> ?shareOperationId .`
    : '';
  const result = await store.query(`
    SELECT ?assertionVersion ?assertionGraph ${shareOperationSelection} WHERE {
      GRAPH <${input.graph}> {
        <${input.subject}> <http://dkg.io/ontology/assertionVersion> ?assertionVersion ;
          <http://dkg.io/ontology/assertionGraph> ?assertionGraph .
        ${shareOperationPattern}
      }
    }
    LIMIT 2
  `, { source: 'rfc64-private-release-gate.memoryHeadEvidence' });
  if (result.type !== 'bindings' || result.bindings.length !== 1) return null;
  const row = result.bindings[0];
  const assertionVersion = parsePrivateCatalogLiteralEvidenceV1(
    row?.['assertionVersion'],
  );
  const assertionGraph = namedNodeValue(row?.['assertionGraph']);
  const shareOperationId = input.includeShareOperationId
    ? parsePrivateCatalogLiteralEvidenceV1(row?.['shareOperationId'])
    : undefined;
  if (
    assertionVersion === null
    || typeof assertionGraph !== 'string'
    || (input.includeShareOperationId && shareOperationId === null)
  ) return null;
  return Object.freeze({
    assertionVersion,
    assertionGraph,
    ...(shareOperationId === undefined || shareOperationId === null
      ? {}
      : { shareOperationId }),
  });
}

/** Parse one rendered binding and accept only a canonical RDF literal. */
export function parsePrivateCatalogLiteralEvidenceV1(term) {
  try {
    const parsed = parseRenderedRdfStoreObjectV1(term);
    return parsed.kind === 'literal' ? parsed.value : null;
  } catch {
    return null;
  }
}

function namedNodeValue(term) {
  try {
    const parsed = parseRenderedRdfStoreObjectV1(term);
    return parsed.kind === 'named-node' ? parsed.value : null;
  } catch {
    return null;
  }
}

function assertPrivateCatalogEvidenceInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('private catalog evidence input must be an object');
  }
  for (const field of ['networkId', 'contextGraphId', 'authorAddress']) {
    if (typeof input[field] !== 'string' || input[field].length === 0) {
      throw new TypeError(`private catalog evidence ${field} is required`);
    }
  }
  if (
    !Array.isArray(input.assetNumbers)
    || input.assetNumbers.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new TypeError('private catalog evidence assetNumbers must be safe integers');
  }
  if (input.swmProofMode !== 'workspace-head' && input.swmProofMode !== 'catalog-row') {
    throw new TypeError('private catalog evidence swmProofMode is required');
  }
  if (input.swmProofMode === 'catalog-row') {
    readVerifiedCatalogRowSwmProofV1(input.catalogClosure, input.assetNumbers[0] ?? 0);
  }
}

/**
 * Validate the flattened process evidence against one explicit fixture model.
 * Asset and statement cardinalities are supplied by the fixture rather than
 * duplicated as magic numbers in the executable runner.
 */
export function hasExactPrivateCatalogMemoryContents(state, expected) {
  return hasExactPrivateCatalogSwmContents(state, {
    assetNumbers: expected?.assetNumbers,
    ...expected?.swm,
  }) && hasExactPrivateCatalogVmContents(state, {
    assetNumbers: expected?.assetNumbers,
    ...expected?.vm,
  });
}

export function hasExactPrivateCatalogSwmContents(state, expected) {
  return hasExactPrivateCatalogLayerContents(state, expected, 'swm');
}

export function hasExactPrivateCatalogVmContents(state, expected) {
  return hasExactPrivateCatalogLayerContents(state, expected, 'vm');
}

function hasExactPrivateCatalogLayerContents(state, expected, layer) {
  if (!Array.isArray(state?.graphCounts) || !Array.isArray(expected?.assetNumbers)) return false;
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
  return state.graphCounts.every((evidence) => {
    const count = evidence[layer];
    const digest = evidence[`${layer}Digest`];
    const graph = evidence[`${layer}Graph`];
    const exactLayerIdentity = layer === 'swm'
      ? hasExactSwmProofV1(state, evidence, expected)
      : evidence.vmHead?.assertionVersion === expected.assertionVersion
        && evidence.vmHead?.assertionGraph === graph;
    return count === projection?.count
      && digest === projection?.digest
      && exactLayerIdentity;
  });
}

function hasExactSwmProofV1(state, evidence, expected) {
  const proof = evidence.swmProof;
  if (expected.proofKind === 'workspace-head') {
    return hasExactKeysV1(
      proof,
      ['assertionGraph', 'assertionVersion', 'kind', 'shareOperationId'],
    )
      && proof.kind === 'workspace-head'
      && proof.assertionVersion === expected.assertionVersion
      && proof.assertionGraph === evidence.swmGraph
      && proof.shareOperationId
        === `${expected.shareOperationIdPrefix ?? ''}${evidence.kaNumber}`;
  }
  if (expected.proofKind === 'catalog-row') {
    const expectedKaId = ((BigInt(expected.authorAddress) << 96n)
      | BigInt(evidence.kaNumber)).toString();
    return hasExactKeysV1(
      proof,
      ['assertionVersion', 'catalogHeadDigest', 'kaId', 'kind', 'projectionDigest'],
    )
      && proof.kind === 'catalog-row'
      && proof.assertionVersion === expected.assertionVersion
      && proof.catalogHeadDigest === state.appliedHeadDigest
      && proof.kaId === expectedKaId
      && proof.projectionDigest === expected.catalogProjectionDigest
      && state.exactExpectedHead === true
      && state.catalogVersion === expected.catalogVersion;
  }
  return false;
}

function hasExactKeysV1(value, expected) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

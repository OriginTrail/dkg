// SPDX-License-Identifier: Apache-2.0
// @ts-check

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
import { packKnowledgeAssetIdFromIdentity } from '../../src/ka-identity.ts';

const DEFAULT_MAX_QUAD_COUNT = 16;
const DEFAULT_MAX_NQUADS_BYTES = 64 * 1024;

/** @typedef {import('@origintrail-official/dkg-storage').Quad} Quad */
/** @typedef {import('@origintrail-official/dkg-storage').TripleStore} TripleStore */
/** @typedef {{ readonly count: number, readonly digest: string }} Rfc64PrivateGraphProjectionEvidenceV1 */
/** @typedef {{ readonly assertionVersion: string, readonly assertionGraph: string, readonly shareOperationId?: string }} Rfc64PrivateLayerHeadEvidenceV1 */
/** @typedef {{ readonly kind: 'absent' }} Rfc64PrivateAbsentSwmProofV1 */
/** @typedef {{ readonly kind: 'workspace-head', readonly assertionVersion: string, readonly assertionGraph: string, readonly shareOperationId: string }} Rfc64PrivateWorkspaceHeadSwmProofV1 */
/** @typedef {{ readonly kind: 'catalog-row', readonly assertionVersion: string, readonly catalogHeadDigest: string, readonly kaId: string, readonly projectionDigest: string }} Rfc64PrivateCatalogRowSwmProofV1 */
/** @typedef {Rfc64PrivateAbsentSwmProofV1 | Rfc64PrivateWorkspaceHeadSwmProofV1 | Rfc64PrivateCatalogRowSwmProofV1} Rfc64PrivateSwmProofV1 */
/** @typedef {{ readonly kaNumber: number, readonly kaUal: string, readonly swmGraph: string, readonly swm: number, readonly swmDigest: string, readonly swmProof: Rfc64PrivateSwmProofV1, readonly vmGraph: string, readonly vm: number, readonly vmDigest: string, readonly vmHead: Rfc64PrivateLayerHeadEvidenceV1 | null }} Rfc64PrivateCatalogMemoryEvidenceRowV1 */
/** @typedef {{ readonly kaNumber: number, readonly kaUal: string, readonly swmGraph: string, readonly swm: number, readonly swmDigest: string, readonly vmGraph: string, readonly vm: number, readonly vmDigest: string, readonly vmHead: Rfc64PrivateLayerHeadEvidenceV1 | null }} Rfc64PrivateCatalogAppliedProjectionEvidenceRowV1 */
/** @typedef {{ readonly assetNumbers: readonly number[], readonly networkId: string, readonly contextGraphId: string, readonly authorAddress: string }} Rfc64PrivateCatalogEvidenceInputV1 */
/** @typedef {{ readonly projection: Rfc64PrivateGraphProjectionEvidenceV1, readonly assertionVersion: string }} Rfc64PrivateVmExpectationV1 */
/** @typedef {Rfc64PrivateVmExpectationV1 & { readonly proofKind: 'workspace-head', readonly shareOperationIdPrefix?: string }} Rfc64PrivateWorkspaceSwmExpectationV1 */
/** @typedef {Rfc64PrivateVmExpectationV1 & { readonly proofKind: 'catalog-row', readonly authorAddress: string, readonly catalogProjectionDigest: string, readonly catalogVersion: string }} Rfc64PrivateCatalogSwmExpectationV1 */
/** @typedef {Rfc64PrivateWorkspaceSwmExpectationV1 | Rfc64PrivateCatalogSwmExpectationV1} Rfc64PrivateSwmExpectationDefinitionV1 */
/** @typedef {Rfc64PrivateSwmExpectationDefinitionV1 & { readonly assetNumbers: readonly number[] }} Rfc64PrivateSwmExpectationV1 */
/** @typedef {{ readonly graphCounts: readonly Rfc64PrivateCatalogMemoryEvidenceRowV1[], readonly appliedHeadDigest?: string | null, readonly exactExpectedHead?: boolean | null, readonly catalogVersion?: string | null }} Rfc64PrivateCatalogMemoryStateV1 */
/** @typedef {{ readonly assetNumbers: readonly number[], readonly swm: Rfc64PrivateSwmExpectationDefinitionV1, readonly vm: Rfc64PrivateVmExpectationV1, readonly finalizedVmBaseline: Rfc64PrivateVmExpectationV1 & { readonly authorAddress: string, readonly catalogProjectionDigest: string, readonly catalogVersion: string } }} Rfc64PrivateCatalogMemoryExpectationV1 */

/** Canonical graph-name-independent serialization for one projection model. */
/** @param {readonly Quad[]} quads */
export function canonicalGraphlessProjectionNQuads(quads) {
  return quadsToNQuads(quads.map(({ subject, predicate, object }) => ({
    subject,
    predicate,
    object,
    graph: '',
  }))).split('\n').sort().join('\n');
}

/** Pure projection evidence shared by fixture construction and store reads. */
/**
 * @param {readonly Quad[]} quads
 * @returns {Readonly<Rfc64PrivateGraphProjectionEvidenceV1>}
 */
export function computeGraphlessMemoryEvidence(quads) {
  const canonicalNQuads = canonicalGraphlessProjectionNQuads(quads);
  return Object.freeze({
    count: quads.length,
    digest: createHash('sha256').update(canonicalNQuads, 'utf8').digest('hex'),
  });
}

/** Bind the canonical graphless fixture projection to one concrete memory graph. */
/**
 * @param {readonly Quad[]} quads
 * @param {string} graph
 * @returns {Quad[]}
 */
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
 * @param {TripleStore} store
 * @param {string} graph
 * @param {{ maxQuadCount?: number, maxNQuadsBytes?: number }} [options]
 * @returns {Promise<Readonly<Rfc64PrivateGraphProjectionEvidenceV1>>}
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
 * @param {TripleStore} store
 * @param {Rfc64PrivateCatalogEvidenceInputV1} input
 * @returns {Promise<readonly Readonly<Rfc64PrivateCatalogMemoryEvidenceRowV1>[]>}
 */
export async function readPrivateCatalogWorkspaceMemoryEvidenceV1(store, input) {
  assertPrivateCatalogEvidenceInput(input);
  return Object.freeze(await Promise.all(input.assetNumbers.map(async (kaNumber) => {
    const kaUal = `did:dkg:${input.networkId}/${input.authorAddress}/${kaNumber}`;
    const [entry, swmHead] = await Promise.all([
      readPrivateCatalogBaseProjectionEvidenceRowV1(store, input, kaNumber),
      readLayerHeadEvidence(store, {
        graph: contextGraphWorkspaceMetaGraphUri(input.contextGraphId),
        subject: `${kaUal}#dkg-swm-head`,
        includeShareOperationId: true,
      }),
    ]);
    return Object.freeze({ ...entry, swmProof: workspaceHeadProofV1(swmHead) });
  })));
}

/** Shared graph-read primitive used by the verified applied-catalog path. */
/**
 * @param {TripleStore} store
 * @param {Rfc64PrivateCatalogEvidenceInputV1} input
 * @returns {Promise<readonly Readonly<Rfc64PrivateCatalogAppliedProjectionEvidenceRowV1>[]>}
 */
export async function readPrivateCatalogAppliedProjectionEvidenceV1(store, input) {
  assertPrivateCatalogEvidenceInput(input);
  return Object.freeze(await Promise.all(input.assetNumbers.map(
    (kaNumber) => readPrivateCatalogBaseProjectionEvidenceRowV1(store, input, kaNumber),
  )));
}

/**
 * @param {TripleStore} store
 * @param {Rfc64PrivateCatalogEvidenceInputV1} input
 * @param {number} kaNumber
 * @returns {Promise<Readonly<Rfc64PrivateCatalogAppliedProjectionEvidenceRowV1>>}
 */
async function readPrivateCatalogBaseProjectionEvidenceRowV1(store, input, kaNumber) {
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
  const [swm, vm, vmHead] = await Promise.all([
    readExactGraphMemoryEvidence(store, swmGraph),
    readExactGraphMemoryEvidence(store, vmGraph),
    readLayerHeadEvidence(store, {
      graph: contextGraphMetaUri(input.contextGraphId),
      subject: kaUal,
      includeShareOperationId: false,
    }),
  ]);
  return Object.freeze({
    kaNumber,
    kaUal,
    swmGraph,
    swm: swm.count,
    swmDigest: swm.digest,
    vmGraph,
    vm: vm.count,
    vmDigest: vm.digest,
    vmHead,
  });
}

/**
 * @param {Rfc64PrivateLayerHeadEvidenceV1 | null | undefined} head
 * @returns {Readonly<Rfc64PrivateAbsentSwmProofV1 | Rfc64PrivateWorkspaceHeadSwmProofV1>}
 */
function workspaceHeadProofV1(head) {
  return head === null || head === undefined || typeof head.shareOperationId !== 'string'
    ? Object.freeze({ kind: 'absent' })
    : Object.freeze({
        kind: 'workspace-head',
        assertionVersion: head.assertionVersion,
        assertionGraph: head.assertionGraph,
        shareOperationId: head.shareOperationId,
      });
}

/**
 * @param {TripleStore} store
 * @param {{ graph: string, subject: string, includeShareOperationId: boolean }} input
 * @returns {Promise<Readonly<Rfc64PrivateLayerHeadEvidenceV1> | null>}
 */
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
/** @param {unknown} term */
export function parsePrivateCatalogLiteralEvidenceV1(term) {
  try {
    const parsed = parseRenderedRdfStoreObjectV1(term);
    return parsed.kind === 'literal' ? parsed.value : null;
  } catch {
    return null;
  }
}

/** @param {unknown} term */
function namedNodeValue(term) {
  try {
    const parsed = parseRenderedRdfStoreObjectV1(term);
    return parsed.kind === 'named-node' ? parsed.value : null;
  } catch {
    return null;
  }
}

/**
 * @param {Rfc64PrivateCatalogEvidenceInputV1} input
 * @returns {asserts input is Rfc64PrivateCatalogEvidenceInputV1}
 */
function assertPrivateCatalogEvidenceInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('private catalog evidence input must be an object');
  }
  for (const field of /** @type {const} */ (['networkId', 'contextGraphId', 'authorAddress'])) {
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
}

/**
 * Validate the flattened process evidence against one explicit fixture model.
 * Asset and statement cardinalities are supplied by the fixture rather than
 * duplicated as magic numbers in the executable runner.
 * @param {Rfc64PrivateCatalogMemoryStateV1} state
 * @param {Rfc64PrivateCatalogMemoryExpectationV1} expected
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

/** Exact pre-update state: canonical finalized VM evidence and no staged SWM. */
/**
 * @param {Rfc64PrivateCatalogMemoryStateV1} state
 * @param {Rfc64PrivateCatalogMemoryExpectationV1} expected
 * @param {{ swmProofKind?: 'absent' | 'catalog-row' }} [options]
 */
export function hasExactPrivateCatalogFinalizedVmBaselineContents(
  state,
  expected,
  { swmProofKind = 'catalog-row' } = {},
) {
  const baseline = expected?.finalizedVmBaseline;
  return hasExactPrivateCatalogVmContents(state, {
    assetNumbers: expected?.assetNumbers,
    ...expected?.vm,
  })
    && state.graphCounts.every((evidence) => (
      evidence.swm === baseline?.projection?.count
      && evidence.swmDigest === baseline?.projection?.digest
      && (
        swmProofKind === 'absent'
          ? hasExactKeysV1(evidence.swmProof, ['kind'])
            && evidence.swmProof.kind === 'absent'
          : swmProofKind === 'catalog-row'
            && hasExactSwmProofV1(state, evidence, {
              ...baseline,
              proofKind: 'catalog-row',
            })
      )
    ));
}

/**
 * @param {Rfc64PrivateCatalogMemoryStateV1} state
 * @param {Rfc64PrivateSwmExpectationV1} expected
 */
export function hasExactPrivateCatalogSwmContents(state, expected) {
  if (!hasExactPrivateCatalogAssetSetV1(state, expected.assetNumbers)) return false;
  return state.graphCounts.every((evidence) => (
    evidence.swm === expected.projection?.count
    && evidence.swmDigest === expected.projection?.digest
    && hasExactSwmProofV1(state, evidence, expected)
  ));
}

/**
 * @param {Rfc64PrivateCatalogMemoryStateV1} state
 * @param {Rfc64PrivateVmExpectationV1 & { readonly assetNumbers: readonly number[] }} expected
 */
export function hasExactPrivateCatalogVmContents(state, expected) {
  if (!hasExactPrivateCatalogAssetSetV1(state, expected.assetNumbers)) return false;
  return state.graphCounts.every((evidence) => (
    evidence.vm === expected.projection?.count
    && evidence.vmDigest === expected.projection?.digest
    && hasExactKeysV1(evidence.vmHead, ['assertionGraph', 'assertionVersion'])
    && evidence.vmHead?.assertionVersion === expected.assertionVersion
    && evidence.vmHead?.assertionGraph === evidence.vmGraph
  ));
}

/**
 * @param {Rfc64PrivateCatalogMemoryStateV1} state
 * @param {readonly number[]} expectedAssetNumbers
 */
function hasExactPrivateCatalogAssetSetV1(state, expectedAssetNumbers) {
  if (!Array.isArray(state?.graphCounts) || !Array.isArray(expectedAssetNumbers)) return false;
  const expectedAssets = new Set(expectedAssetNumbers);
  const actualAssets = new Set(state.graphCounts.map(({ kaNumber }) => kaNumber));
  return !(
    state.graphCounts.length !== expectedAssets.size
    || actualAssets.size !== expectedAssets.size
    || [...expectedAssets].some((kaNumber) => !actualAssets.has(kaNumber))
  );
}

/**
 * @param {Rfc64PrivateCatalogMemoryStateV1} state
 * @param {Rfc64PrivateCatalogMemoryEvidenceRowV1} evidence
 * @param {Rfc64PrivateSwmExpectationDefinitionV1} expected
 */
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
    const expectedKaId = packKnowledgeAssetIdFromIdentity({
      agentAddress: expected.authorAddress,
      kaNumber: evidence.kaNumber,
    }).toString();
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

/**
 * @param {unknown} value
 * @param {readonly string[]} expected
 */
function hasExactKeysV1(value, expected) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

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
/** @typedef {import('./scenario-result.ts').Rfc64PrivateLayerHeadEvidenceV1} Rfc64PrivateLayerHeadEvidenceV1 */
/** @typedef {Rfc64PrivateLayerHeadEvidenceV1 & { readonly shareOperationId?: string }} Rfc64PrivateReadLayerHeadEvidenceV1 */
/** @typedef {Extract<import('./scenario-result.ts').Rfc64PrivateSwmProofV1, { readonly kind: 'absent' }>} Rfc64PrivateAbsentSwmProofV1 */
/** @typedef {Extract<import('./scenario-result.ts').Rfc64PrivateSwmProofV1, { readonly kind: 'workspace-head' }>} Rfc64PrivateWorkspaceHeadSwmProofV1 */
/** @typedef {Extract<import('./scenario-result.ts').Rfc64PrivateSwmProofV1, { readonly kind: 'catalog-row' }>} Rfc64PrivateCatalogRowSwmProofV1 */
/** @typedef {import('./scenario-result.ts').Rfc64PrivateMemoryRowEvidenceV1} Rfc64PrivateCatalogMemoryEvidenceRowV1 */
/** @typedef {{ readonly kaNumber: number, readonly kaUal: string, readonly swmGraph: string, readonly swm: number, readonly swmDigest: string, readonly vmGraph: string, readonly vm: number, readonly vmDigest: string, readonly vmHead: Rfc64PrivateLayerHeadEvidenceV1 | null }} Rfc64PrivateCatalogAppliedProjectionEvidenceRowV1 */
/** @typedef {{ readonly assetNumbers: readonly number[], readonly networkId: string, readonly contextGraphId: string, readonly authorAddress: string }} Rfc64PrivateCatalogEvidenceInputV1 */
/** @typedef {{ readonly projection: Rfc64PrivateGraphProjectionEvidenceV1, readonly assertionVersion: string }} Rfc64PrivateVmExpectationV1 */
/** @typedef {Rfc64PrivateVmExpectationV1 & { readonly proofKind: 'workspace-head', readonly shareOperationIdPrefix?: string }} Rfc64PrivateWorkspaceSwmExpectationV1 */
/** @typedef {Rfc64PrivateVmExpectationV1 & { readonly proofKind: 'catalog-row', readonly authorAddress: string, readonly catalogProjectionDigest: string, readonly catalogVersion: string }} Rfc64PrivateCatalogSwmExpectationV1 */
/** @typedef {Rfc64PrivateWorkspaceSwmExpectationV1 | Rfc64PrivateCatalogSwmExpectationV1} Rfc64PrivateSwmExpectationDefinitionV1 */
/** @typedef {Rfc64PrivateSwmExpectationDefinitionV1 & { readonly assetNumbers: readonly number[] }} Rfc64PrivateSwmExpectationV1 */
/** @typedef {{ readonly graphCounts: readonly Rfc64PrivateCatalogMemoryEvidenceRowV1[], readonly appliedHeadDigest?: string | null, readonly exactExpectedHead?: boolean | null, readonly catalogVersion?: string | null }} Rfc64PrivateCatalogMemoryStateV1 */
/** @typedef {{ readonly assetNumbers: readonly number[], readonly swm: Rfc64PrivateSwmExpectationDefinitionV1, readonly vm: Rfc64PrivateVmExpectationV1, readonly finalizedVmBaseline: Rfc64PrivateVmExpectationV1 & { readonly authorAddress: string, readonly catalogProjectionDigest: string, readonly catalogVersion: string } }} Rfc64PrivateCatalogMemoryExpectationV1 */
/** @typedef {{ readonly networkId: string, readonly authorAddress: string }} Rfc64PrivateMemoryIdentityV1 */
/** @typedef {{ readonly proofKind: 'absent', readonly projection: Rfc64PrivateGraphProjectionEvidenceV1 } | Rfc64PrivateSwmExpectationDefinitionV1} Rfc64PrivateStrictSwmProfileV1 */
/** @typedef {Rfc64PrivateVmExpectationV1 & { readonly headKind: 'present' | 'absent' }} Rfc64PrivateStrictVmProfileV1 */
/** @typedef {{ readonly appliedHeadDigest: unknown, readonly catalogVersion: unknown, readonly exactExpectedHead: unknown }} Rfc64PrivateCatalogProofBindingV1 */
/** @typedef {{ readonly assetNumbers: readonly number[], readonly catalogProofBinding?: Rfc64PrivateCatalogProofBindingV1, readonly identity?: Rfc64PrivateMemoryIdentityV1, readonly swm?: Rfc64PrivateStrictSwmProfileV1, readonly vm?: Rfc64PrivateStrictVmProfileV1 }} Rfc64PrivateMemoryEvidenceProfileV1 */

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
 * @param {Rfc64PrivateReadLayerHeadEvidenceV1 | null | undefined} head
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
 * @returns {Promise<Readonly<Rfc64PrivateReadLayerHeadEvidenceV1> | null>}
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
  return decodesExactMemoryV1(state, {
    assetNumbers: expected?.assetNumbers,
    swm: expected?.swm,
    vm: { ...expected?.vm, headKind: 'present' },
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
  return decodesExactMemoryV1(state, {
    assetNumbers: expected?.assetNumbers,
    swm: swmProofKind === 'absent'
      ? { projection: baseline?.projection, proofKind: 'absent' }
      : { ...baseline, proofKind: 'catalog-row' },
    vm: { ...expected?.vm, headKind: 'present' },
  });
}

/**
 * @param {Rfc64PrivateCatalogMemoryStateV1} state
 * @param {Rfc64PrivateSwmExpectationV1} expected
 */
export function hasExactPrivateCatalogSwmContents(state, expected) {
  return decodesExactMemoryV1(state, {
    assetNumbers: expected?.assetNumbers,
    swm: expected,
  });
}

/**
 * @param {Rfc64PrivateCatalogMemoryStateV1} state
 * @param {Rfc64PrivateVmExpectationV1 & { readonly assetNumbers: readonly number[] }} expected
 */
export function hasExactPrivateCatalogVmContents(state, expected) {
  return decodesExactMemoryV1(state, {
    assetNumbers: expected?.assetNumbers,
    vm: { ...expected, headKind: 'present' },
  });
}

/**
 * One strict row/proof decoder shared by live checks and persisted gate codecs.
 * The profile names which layers are required and whether identity is bound.
 * @param {unknown} stateInput
 * @param {Rfc64PrivateMemoryEvidenceProfileV1} profile
 * @param {string} [label]
 * @returns {readonly Readonly<Rfc64PrivateCatalogMemoryEvidenceRowV1>[]}
 */
export function decodePrivateCatalogMemoryEvidenceV1(
  stateInput,
  profile,
  label = 'private catalog memory evidence',
) {
  const state = plainMemoryRecordV1(stateInput, `${label} state`);
  if (!Array.isArray(state.graphCounts) || !Array.isArray(profile?.assetNumbers)) {
    throw new TypeError(`${label} graph inventory must be an array`);
  }
  if (profile.swm === undefined && profile.vm === undefined) {
    throw new TypeError(`${label} profile must require at least one memory layer`);
  }
  if (
    state.graphCounts.length !== profile.assetNumbers.length
    || new Set(profile.assetNumbers).size !== profile.assetNumbers.length
  ) {
    throw new TypeError(`${label} graph inventory differs from its profile`);
  }
  const memory = state.graphCounts.map((entry, index) => {
    const row = plainMemoryRecordV1(entry, `${label} graph ${index}`);
    assertExactMemoryKeysV1(row, [
      'kaNumber', 'kaUal', 'swm', 'swmDigest', 'swmGraph', 'swmProof',
      'vm', 'vmDigest', 'vmGraph', 'vmHead',
    ], `${label} graph ${index}`);
    if (
      !Number.isSafeInteger(row.kaNumber)
      || row.kaNumber !== profile.assetNumbers[index]
      || typeof row.kaUal !== 'string'
      || !validProjectionCountV1(row.swm)
      || !validProjectionCountV1(row.vm)
      || !validProjectionDigestV1(row.swmDigest)
      || !validProjectionDigestV1(row.vmDigest)
      || !validGraphNameV1(row.swmGraph)
      || !validGraphNameV1(row.vmGraph)
      || row.swmGraph === row.vmGraph
    ) throw new TypeError(`${label} graph ${index} is malformed`);
    if (
      profile.identity !== undefined
      && row.kaUal !== `did:dkg:${profile.identity.networkId}/`
        + `${profile.identity.authorAddress}/${row.kaNumber}`
    ) throw new TypeError(`${label} graph ${index} has a noncanonical KA UAL`);
    if (profile.swm !== undefined) {
      decodePrivateCatalogSwmProofV1(
        profile.catalogProofBinding ?? state,
        row,
        profile.swm,
        `${label} graph ${index}`,
      );
    }
    if (profile.vm !== undefined) {
      decodePrivateCatalogVmHeadV1(row, profile.vm, `${label} graph ${index}`);
    }
    return Object.freeze(/** @type {Rfc64PrivateCatalogMemoryEvidenceRowV1} */ ({
      kaNumber: row.kaNumber,
      kaUal: row.kaUal,
      swm: row.swm,
      swmDigest: row.swmDigest,
      swmGraph: row.swmGraph,
      swmProof: row.swmProof,
      vm: row.vm,
      vmDigest: row.vmDigest,
      vmGraph: row.vmGraph,
      vmHead: row.vmHead,
    }));
  });
  return Object.freeze(memory);
}

/**
 * @param {Readonly<Record<string, unknown>>} state
 * @param {Readonly<Record<string, unknown>>} row
 * @param {Rfc64PrivateStrictSwmProfileV1} expected
 * @param {string} label
 */
function decodePrivateCatalogSwmProofV1(state, row, expected, label) {
  if (
    row.swm !== expected.projection?.count
    || row.swmDigest !== expected.projection?.digest
  ) throw new TypeError(`${label} SWM projection differs from its profile`);
  const proof = plainMemoryRecordV1(row.swmProof, `${label} SWM proof`);
  if (expected.proofKind === 'absent') {
    assertExactMemoryKeysV1(proof, ['kind'], `${label} SWM proof`);
    if (proof.kind !== 'absent') throw new TypeError(`${label} has unexpected SWM proof`);
    return;
  }
  if (expected.proofKind === 'workspace-head') {
    assertExactMemoryKeysV1(
      proof,
      ['assertionGraph', 'assertionVersion', 'kind', 'shareOperationId'],
      `${label} SWM proof`,
    );
    if (
      proof.kind !== 'workspace-head'
      || proof.assertionVersion !== expected.assertionVersion
      || proof.assertionGraph !== row.swmGraph
      || proof.shareOperationId
        !== `${expected.shareOperationIdPrefix ?? ''}${row.kaNumber}`
    ) throw new TypeError(`${label} has a malformed workspace proof`);
    return;
  }
  assertExactMemoryKeysV1(
    proof,
    ['assertionVersion', 'catalogHeadDigest', 'kaId', 'kind', 'projectionDigest'],
    `${label} SWM proof`,
  );
  const expectedKaId = packKnowledgeAssetIdFromIdentity({
    agentAddress: expected.authorAddress,
    kaNumber: /** @type {number} */ (row.kaNumber),
  }).toString();
  if (
    proof.kind !== 'catalog-row'
    || proof.assertionVersion !== expected.assertionVersion
    || proof.catalogHeadDigest !== state.appliedHeadDigest
    || proof.kaId !== expectedKaId
    || proof.projectionDigest !== expected.catalogProjectionDigest
    || state.exactExpectedHead !== true
    || state.catalogVersion !== expected.catalogVersion
  ) throw new TypeError(`${label} has a noncanonical KA identity proof`);
}

/**
 * @param {Readonly<Record<string, unknown>>} row
 * @param {Rfc64PrivateStrictVmProfileV1} expected
 * @param {string} label
 */
function decodePrivateCatalogVmHeadV1(row, expected, label) {
  if (
    row.vm !== expected.projection?.count
    || row.vmDigest !== expected.projection?.digest
  ) throw new TypeError(`${label} VM projection differs from its profile`);
  if (expected.headKind === 'absent') {
    if (row.vmHead !== null) throw new TypeError(`${label} has unexpected VM head evidence`);
    return;
  }
  const vmHead = plainMemoryRecordV1(row.vmHead, `${label} VM head`);
  assertExactMemoryKeysV1(
    vmHead,
    ['assertionGraph', 'assertionVersion'],
    `${label} VM head`,
  );
  if (
    vmHead.assertionGraph !== row.vmGraph
    || vmHead.assertionVersion !== expected.assertionVersion
  ) throw new TypeError(`${label} VM head is malformed`);
}

/** @param {unknown} value @param {Rfc64PrivateMemoryEvidenceProfileV1} profile */
function decodesExactMemoryV1(value, profile) {
  try {
    decodePrivateCatalogMemoryEvidenceV1(value, profile);
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} value @param {string} label */
function plainMemoryRecordV1(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return /** @type {Readonly<Record<string, unknown>>} */ (value);
}

/**
 * @param {Readonly<Record<string, unknown>>} value
 * @param {readonly string[]} expected
 * @param {string} label
 */
function assertExactMemoryKeysV1(value, expected, label) {
  if (Object.keys(value).sort().join('\n') !== [...expected].sort().join('\n')) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

/** @param {unknown} value */
function validProjectionCountV1(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
}

/** @param {unknown} value */
function validProjectionDigestV1(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

/** @param {unknown} value */
function validGraphNameV1(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 1_024;
}

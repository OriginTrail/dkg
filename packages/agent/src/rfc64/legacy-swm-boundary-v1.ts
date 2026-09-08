// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

import {
  assertCanonicalDeterministicUalV1,
  assertCanonicalDecimalU64,
  assertContextGraphIdV1,
  assertSwmAuthorInventoryShareOperationIdV1,
  contextGraphWorkspaceMetaGraphUri,
  type CanonicalDeterministicUalV1,
  type ContextGraphIdV1,
  type PositiveDecimalU64V1,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';

import { createRfc64DurableFileStoreV1 } from './durable-file-store-v1.js';

const RFC64_LEGACY_SWM_CAPTURE_PATH_V1 = 'legacy-swm-boundary-v1/capture.json';
const RFC64_LEGACY_SWM_REPUBLISHED_PREFIX_V1 =
  'legacy-swm-boundary-v1/republished';
const RFC64_LEGACY_SWM_LATE_MARKER_GRAPH_V1 =
  'urn:dkg:rfc64:legacy-swm-boundary:v1';
const RFC64_LEGACY_SWM_LATE_MARKER_PREDICATE_V1 =
  'urn:dkg:rfc64:legacy-swm-boundary:v1#late-entry';
const RFC64_LEGACY_SWM_LATE_MARKER_SUBJECT_PREFIX_V1 =
  'urn:dkg:rfc64:legacy-swm-boundary:v1:late:';
const RFC64_LEGACY_SWM_CAPTURE_MAX_BYTES_V1 = 64 * 1024 * 1024;
const RFC64_LEGACY_SWM_REPUBLISHED_MAX_BYTES_V1 = 2 * 1024;
const RFC64_LEGACY_SWM_META_GRAPH_LIMIT_V1 = 16_384;
const RFC64_LEGACY_SWM_HEAD_LIMIT_V1 = 100_000;
const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';
const SWM_META_SUFFIX = '/_shared_memory_meta';
const SWM_HEAD_SUFFIX = '#dkg-swm-head';
const KA_UAL = 'http://dkg.io/ontology/kaUal';
const SHARE_OPERATION_ID = 'http://dkg.io/ontology/shareOperationId';
const CONTEXT_GRAPH_ID = 'http://dkg.io/ontology/contextGraphId';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const WORKSPACE_OPERATION = 'http://dkg.io/ontology/WorkspaceOperation';
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

interface Rfc64LegacySwmBoundaryEntryV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly kaUal: CanonicalDeterministicUalV1;
}

interface Rfc64LegacySwmBoundaryCaptureV1 {
  readonly version: 1;
  readonly entries: readonly Rfc64LegacySwmBoundaryEntryV1[];
}

interface Rfc64LegacySwmRepublishedMarkerV1
  extends Rfc64LegacySwmBoundaryEntryV1 {
  readonly version: 1;
}

interface Rfc64LateLegacySwmBoundaryEntryV1
  extends Rfc64LegacySwmBoundaryEntryV1 {
  readonly version: 1;
  readonly shareOperationId: string;
  readonly assertionVersion: PositiveDecimalU64V1;
}

interface Rfc64OutstandingLegacySwmBoundaryEntryV1 {
  readonly entry: Rfc64LegacySwmBoundaryEntryV1;
  /** Null identifies an entry owned by the immutable first-upgrade capture. */
  readonly lateMarker: Quad | null;
}

export interface Rfc64LateLegacySwmAtomicCompanionV1 {
  readonly graphUri: string;
  readonly subject: string;
  readonly quads: readonly Quad[];
  readonly settle: (committed: boolean | undefined) => void;
}

interface Rfc64LegacySwmBoundaryStateV1 {
  readonly durableFiles: ReturnType<typeof createRfc64DurableFileStoreV1>;
  readonly store: TripleStore;
  readonly entriesByContextGraph: Map<
    string,
    Map<string, Rfc64OutstandingLegacySwmBoundaryEntryV1[]>
  >;
  entryCount: number;
  mutationTail: Promise<void>;
  activePreparations: number;
  preparationsDrained: Promise<void>;
  resolvePreparationsDrained: (() => void) | undefined;
  retirementPending: number;
}

const rfc64LegacySwmBoundaryStatesV1 =
  new WeakMap<object, Rfc64LegacySwmBoundaryStateV1>();

/**
 * Establish the one-time 10.0.16 upgrade boundary before networking starts.
 * Existing graph-scoped SWM heads remain readable through the legacy store but
 * are never inferred into a signed catalog. Only a later normal share/update
 * may durably retire a captured entry.
 */
export async function initializeRfc64LegacySwmBoundaryV1(
  owner: object,
  persistenceRoot: string,
  store: TripleStore,
): Promise<void> {
  const durableFiles = createRfc64DurableFileStoreV1<'capture' | 'republished'>(
    persistenceRoot,
  );
  const existing = await durableFiles.readOptionalBoundedBytes({
    relativePath: RFC64_LEGACY_SWM_CAPTURE_PATH_V1,
    maxBytes: RFC64_LEGACY_SWM_CAPTURE_MAX_BYTES_V1,
    label: 'RFC-64 legacy SWM boundary capture',
  });
  const capture = existing === null
    ? await captureRfc64LegacySwmBoundaryV1(store)
    : parseRfc64LegacySwmBoundaryCaptureV1(existing);
  if (
    existing !== null
    && !bytesEqual(existing, encodeRfc64LegacySwmBoundaryCaptureV1(capture))
  ) {
    throw new Error('RFC-64 legacy SWM boundary capture is not canonical');
  }
  if (existing === null) {
    await durableFiles.putExactBytes({
      relativePath: RFC64_LEGACY_SWM_CAPTURE_PATH_V1,
      bytes: encodeRfc64LegacySwmBoundaryCaptureV1(capture),
      maxBytes: RFC64_LEGACY_SWM_CAPTURE_MAX_BYTES_V1,
      label: 'RFC-64 legacy SWM boundary capture',
      kind: 'capture',
    });
  }

  const entriesByContextGraph = new Map<
    string,
    Map<string, Rfc64OutstandingLegacySwmBoundaryEntryV1[]>
  >();
  let entryCount = 0;
  for (const entry of capture.entries) {
    const marker = encodeRfc64LegacySwmRepublishedMarkerV1(entry);
    const retired = await durableFiles.readOptionalBoundedBytes({
      relativePath: rfc64LegacySwmRepublishedPathV1(entry),
      maxBytes: RFC64_LEGACY_SWM_REPUBLISHED_MAX_BYTES_V1,
      label: 'RFC-64 legacy SWM republished marker',
    });
    if (retired !== null) {
      if (!bytesEqual(retired, marker)) {
        throw new Error(
          `RFC-64 legacy SWM republished marker differs for ${entry.kaUal}`,
        );
      }
      continue;
    }
    addRfc64OutstandingLegacySwmBoundaryEntryV1(entriesByContextGraph, {
      entry,
      lateMarker: null,
    });
    entryCount += 1;
  }
  const lateEntries = await readRfc64LateLegacySwmBoundaryEntriesV1(store);
  if (entryCount + lateEntries.length > RFC64_LEGACY_SWM_HEAD_LIMIT_V1) {
    throw new Error(
      `RFC-64 legacy SWM boundary exceeds head limit ` +
      `${RFC64_LEGACY_SWM_HEAD_LIMIT_V1}`,
    );
  }
  for (const lateEntry of lateEntries) {
    addRfc64OutstandingLegacySwmBoundaryEntryV1(entriesByContextGraph, {
      entry: lateEntry,
      lateMarker: rfc64LateLegacySwmBoundaryMarkerQuadV1(lateEntry),
    });
    entryCount += 1;
  }
  rfc64LegacySwmBoundaryStatesV1.set(owner, {
    durableFiles,
    store,
    entriesByContextGraph,
    entryCount,
    mutationTail: Promise.resolve(),
    activePreparations: 0,
    preparationsDrained: Promise.resolve(),
    resolvePreparationsDrained: undefined,
    retirementPending: 0,
  });
}

/** Privacy-safe status projection: expose a count, never historical UALs. */
export function readRfc64LegacySwmBoundaryCountV1(
  owner: object,
  contextGraphId: string,
): number {
  return rfc64LegacySwmBoundaryStatesV1.get(owner)
    ?.entriesByContextGraph.get(contextGraphId)?.size ?? 0;
}

/**
 * Prepare the exact negative-completeness marker that the publisher commits
 * atomically with a root SWM graph while explicit legacy authority or the
 * global kill switch owns delivery. Hydrating process-local state first is
 * conservative on a clean capability refusal and idempotent across retries;
 * only the caller's compound store mutation makes the marker durable.
 */
export function prepareRfc64LateLegacySwmBoundaryV1(
  owner: object,
  contextGraphId: string,
  kaUalInput: string,
  shareOperationId: string,
  assertionVersionInput: string,
): Readonly<Rfc64LateLegacySwmAtomicCompanionV1> {
  const state = rfc64LegacySwmBoundaryStatesV1.get(owner);
  if (state === undefined) {
    throw new Error('RFC-64 legacy SWM boundary persistence is unavailable');
  }
  assertContextGraphIdV1(
    contextGraphId,
    'RFC-64 late legacy SWM boundary contextGraphId',
  );
  const kaUal = assertCanonicalDeterministicUalV1(kaUalInput).ual;
  assertSwmAuthorInventoryShareOperationIdV1(shareOperationId);
  const assertionVersion = assertPositiveDecimalU64V1(assertionVersionInput);
  if (state.retirementPending > 0) {
    throw new Error('RFC-64 legacy SWM boundary retirement is in progress; retry promotion');
  }
  const entry = Object.freeze({
    version: 1,
    contextGraphId,
    kaUal,
    shareOperationId,
    assertionVersion,
  } satisfies Rfc64LateLegacySwmBoundaryEntryV1);
  const lateMarker = rfc64LateLegacySwmBoundaryMarkerQuadV1(entry);
  const outstanding = state.entriesByContextGraph
    .get(contextGraphId)?.get(kaUal) ?? [];
  const alreadyTracked = outstanding.some((candidate) => (
    candidate.lateMarker?.subject === lateMarker.subject
  ));
  if (!alreadyTracked) {
    if (state.entryCount >= RFC64_LEGACY_SWM_HEAD_LIMIT_V1) {
      throw new Error(
        `RFC-64 legacy SWM boundary exceeds head limit ` +
        `${RFC64_LEGACY_SWM_HEAD_LIMIT_V1}`,
      );
    }
    addRfc64OutstandingLegacySwmBoundaryEntryV1(
      state.entriesByContextGraph,
      { entry, lateMarker },
    );
    state.entryCount += 1;
  }
  beginRfc64LegacySwmBoundaryPreparationV1(state);
  let settled = false;
  return Object.freeze({
    graphUri: RFC64_LEGACY_SWM_LATE_MARKER_GRAPH_V1,
    subject: lateMarker.subject,
    quads: Object.freeze([lateMarker]),
    settle: (committed: boolean | undefined) => {
      if (settled) return;
      settled = true;
      try {
        if (committed === false && !alreadyTracked) {
          removeRfc64OutstandingLegacySwmBoundaryEntryV1(
            state,
            contextGraphId,
            kaUal,
            lateMarker.subject,
          );
        }
      } finally {
        settleRfc64LegacySwmBoundaryPreparationV1(state);
      }
    },
  });
}

export interface Rfc64RepublishedLegacySwmAssetV1 {
  readonly kaUal: string;
  readonly assertionVersion: string;
}

/**
 * Retire only captured historical entries that reached an exact, verified
 * catalog successor through the normal 10.0.16 authoring path.
 */
export async function markRfc64LegacySwmRepublishedV1(
  owner: object,
  contextGraphId: string,
  assets: readonly Readonly<Rfc64RepublishedLegacySwmAssetV1>[],
): Promise<void> {
  const state = rfc64LegacySwmBoundaryStatesV1.get(owner);
  if (state === undefined) return;
  assertContextGraphIdV1(
    contextGraphId,
    'RFC-64 legacy SWM boundary contextGraphId',
  );
  const canonicalContextGraphId = contextGraphId;
  const canonicalAssets = new Map<string, PositiveDecimalU64V1>();
  for (const asset of assets) {
    const kaUal = assertCanonicalDeterministicUalV1(asset.kaUal).ual;
    const assertionVersion = assertPositiveDecimalU64V1(asset.assertionVersion);
    const previous = canonicalAssets.get(kaUal);
    if (previous === undefined || BigInt(assertionVersion) > BigInt(previous)) {
      canonicalAssets.set(kaUal, assertionVersion);
    }
  }
  state.retirementPending += 1;
  try {
    await mutateRfc64LegacySwmBoundaryV1(state, async () => {
      await state.preparationsDrained;
      const outstanding = state.entriesByContextGraph.get(canonicalContextGraphId);
      if (outstanding === undefined || outstanding.size === 0) return;
      for (const [kaUal, catalogVersion] of [...canonicalAssets.entries()].sort()) {
        const entries = outstanding.get(kaUal);
        if (entries === undefined) continue;
        const retired: Rfc64OutstandingLegacySwmBoundaryEntryV1[] = [];
        const retained: Rfc64OutstandingLegacySwmBoundaryEntryV1[] = [];
        for (const tracked of entries) {
          if (
            tracked.lateMarker !== null
            && BigInt((tracked.entry as Rfc64LateLegacySwmBoundaryEntryV1).assertionVersion)
              > BigInt(catalogVersion)
          ) {
            retained.push(tracked);
            continue;
          }
          retired.push(tracked);
        }
        for (const tracked of retired) {
          if (tracked.lateMarker === null) {
            await state.durableFiles.putExactBytes({
              relativePath: rfc64LegacySwmRepublishedPathV1(tracked.entry),
              bytes: encodeRfc64LegacySwmRepublishedMarkerV1(tracked.entry),
              maxBytes: RFC64_LEGACY_SWM_REPUBLISHED_MAX_BYTES_V1,
              label: 'RFC-64 legacy SWM republished marker',
              kind: 'republished',
            });
          } else {
            await state.store.delete([tracked.lateMarker], {
              source: 'agent.rfc64.legacySwmBoundary.retireLate',
              priority: 'normal',
            });
          }
        }
        state.entryCount -= retired.length;
        if (retained.length === 0) outstanding.delete(kaUal);
        else outstanding.set(kaUal, retained);
      }
      if (outstanding.size === 0) {
        state.entriesByContextGraph.delete(canonicalContextGraphId);
      }
    });
  } finally {
    state.retirementPending -= 1;
  }
}

async function readRfc64LateLegacySwmBoundaryEntriesV1(
  store: TripleStore,
): Promise<readonly Rfc64LateLegacySwmBoundaryEntryV1[]> {
  const result = await store.query(
    `SELECT ?marker ?entry WHERE { ` +
    `GRAPH <${RFC64_LEGACY_SWM_LATE_MARKER_GRAPH_V1}> { ` +
    `?marker <${RFC64_LEGACY_SWM_LATE_MARKER_PREDICATE_V1}> ?entry ` +
    `} } LIMIT ${RFC64_LEGACY_SWM_HEAD_LIMIT_V1 + 1}`,
    {
      source: 'agent.rfc64.legacySwmBoundary.readLate',
      priority: 'background',
    },
  );
  if (result.type !== 'bindings') {
    throw new Error('RFC-64 late legacy SWM boundary query did not return bindings');
  }
  if (result.bindings.length > RFC64_LEGACY_SWM_HEAD_LIMIT_V1) {
    throw new Error(
      `RFC-64 legacy SWM boundary exceeds head limit ` +
      `${RFC64_LEGACY_SWM_HEAD_LIMIT_V1}`,
    );
  }
  const entries = result.bindings.map((row) => {
    const marker = row['marker'];
    const rawEntry = row['entry'];
    if (marker === undefined || rawEntry === undefined || marker.startsWith('"')) {
      throw new Error('RFC-64 late legacy SWM boundary marker is malformed');
    }
    const encoded = decodeRfc64BindingValueV1(rawEntry);
    const entry = parseRfc64LateLegacySwmBoundaryEntryV1(encoded);
    const expected = rfc64LateLegacySwmBoundaryMarkerQuadV1(entry);
    if (marker !== expected.subject || rawEntry !== expected.object) {
      throw new Error('RFC-64 late legacy SWM boundary marker is not canonical');
    }
    return entry;
  }).sort(compareLateEntries);
  if (entries.some((entry, index) => (
    index > 0 && compareLateEntries(entry, entries[index - 1]!) === 0
  ))) {
    throw new Error('RFC-64 late legacy SWM boundary entries are duplicate');
  }
  return Object.freeze(entries);
}

async function captureRfc64LegacySwmBoundaryV1(
  store: TripleStore,
): Promise<Readonly<Rfc64LegacySwmBoundaryCaptureV1>> {
  // Bind and reject named-subgraph metadata inside the store. URI-only parsing
  // is ambiguous because a valid Context Graph ID may itself contain slashes;
  // enumerating every `.../_shared_memory_meta` graph would also let unrelated
  // named history consume the bounded root-capture budget before classification.
  const result = await store.query(
    `SELECT DISTINCT ?metaGraph ?head ?ual ?contextGraphId WHERE { ` +
    `GRAPH ?metaGraph { ` +
    `?head <${KA_UAL}> ?ual ; <${SHARE_OPERATION_ID}> ?shareId . ` +
    `?operation <${RDF_TYPE}> <${WORKSPACE_OPERATION}> ; ` +
    `<${KA_UAL}> ?ual ; <${SHARE_OPERATION_ID}> ?shareId ; ` +
    `<${CONTEXT_GRAPH_ID}> ?contextGraphId . ` +
    `FILTER(STR(?metaGraph) = CONCAT(` +
    `${JSON.stringify(CONTEXT_GRAPH_PREFIX)}, STR(?contextGraphId), ` +
    `${JSON.stringify(SWM_META_SUFFIX)})) ` +
    `FILTER(STRENDS(STR(?head), ${JSON.stringify(SWM_HEAD_SUFFIX)})) ` +
    `} } LIMIT ${RFC64_LEGACY_SWM_HEAD_LIMIT_V1 + 1}`,
    {
      source: 'agent.rfc64.legacySwmBoundary.readHeads',
      priority: 'background',
    },
  );
  if (result.type !== 'bindings') {
    throw new Error('RFC-64 legacy SWM boundary query did not return bindings');
  }
  if (result.bindings.length > RFC64_LEGACY_SWM_HEAD_LIMIT_V1) {
    throw new Error(
      `RFC-64 legacy SWM boundary exceeds head limit ` +
      `${RFC64_LEGACY_SWM_HEAD_LIMIT_V1}`,
    );
  }

  const rootMetaGraphs = new Set<string>();
  const entries = new Map<string, Rfc64LegacySwmBoundaryEntryV1>();
  for (const row of result.bindings) {
    const metaGraph = row['metaGraph'];
    const head = row['head'];
    const rawUal = row['ual'];
    const rawContextGraphId = row['contextGraphId'];
    if (
      metaGraph === undefined
      || head === undefined
      || rawUal === undefined
      || rawContextGraphId === undefined
    ) {
      throw new Error('RFC-64 legacy SWM boundary returned an incomplete head');
    }
    const contextGraphId = decodeRfc64BindingValueV1(rawContextGraphId);
    assertContextGraphIdV1(
      contextGraphId,
      'RFC-64 legacy SWM boundary contextGraphId',
    );
    if (metaGraph !== contextGraphWorkspaceMetaGraphUri(contextGraphId)) {
      continue;
    }
    rootMetaGraphs.add(metaGraph);
    if (rootMetaGraphs.size > RFC64_LEGACY_SWM_META_GRAPH_LIMIT_V1) {
      throw new Error(
        `RFC-64 legacy SWM boundary exceeds metadata graph limit ` +
        `${RFC64_LEGACY_SWM_META_GRAPH_LIMIT_V1}`,
      );
    }
    const kaUal = assertCanonicalDeterministicUalV1(rawUal).ual;
    if (head !== `${kaUal}${SWM_HEAD_SUFFIX}`) {
      throw new Error(`RFC-64 legacy SWM head identity differs for ${kaUal}`);
    }
    entries.set(`${contextGraphId}\u0000${kaUal}`, Object.freeze({
      contextGraphId,
      kaUal,
    }));
  }
  return Object.freeze({
    version: 1,
    entries: Object.freeze([...entries.values()].sort(compareEntries)),
  });
}

function decodeRfc64BindingValueV1(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const literal = parseRdfLiteralTerm(raw);
  if (literal === null) {
    throw new Error('RFC-64 legacy SWM boundary contains a malformed RDF literal');
  }
  return literal.value;
}

function encodeRfc64LegacySwmBoundaryCaptureV1(
  capture: Readonly<Rfc64LegacySwmBoundaryCaptureV1>,
): Uint8Array {
  return UTF8_ENCODER.encode(`${JSON.stringify(capture)}\n`);
}

function parseRfc64LegacySwmBoundaryCaptureV1(
  bytes: Uint8Array,
): Readonly<Rfc64LegacySwmBoundaryCaptureV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (cause) {
    throw new Error('RFC-64 legacy SWM boundary capture is not valid JSON', { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RFC-64 legacy SWM boundary capture is malformed');
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join('\n') !== 'entries\nversion' || value.version !== 1) {
    throw new Error('RFC-64 legacy SWM boundary capture has unknown fields or version');
  }
  if (!Array.isArray(value.entries) || value.entries.length > RFC64_LEGACY_SWM_HEAD_LIMIT_V1) {
    throw new Error('RFC-64 legacy SWM boundary capture has an invalid entry set');
  }
  const entries = value.entries.map((raw): Rfc64LegacySwmBoundaryEntryV1 => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('RFC-64 legacy SWM boundary entry is malformed');
    }
    const entry = raw as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join('\n') !== 'contextGraphId\nkaUal'
      || typeof entry.contextGraphId !== 'string'
      || typeof entry.kaUal !== 'string'
    ) {
      throw new Error('RFC-64 legacy SWM boundary entry has unknown fields');
    }
    assertContextGraphIdV1(
      entry.contextGraphId,
      'RFC-64 legacy SWM boundary contextGraphId',
    );
    return Object.freeze({
      contextGraphId: entry.contextGraphId,
      kaUal: assertCanonicalDeterministicUalV1(entry.kaUal).ual,
    });
  });
  const sorted = [...entries].sort(compareEntries);
  if (
    sorted.some((entry, index) => compareEntries(entry, entries[index]!) !== 0)
    || sorted.some((entry, index) => index > 0 && compareEntries(entry, sorted[index - 1]!) === 0)
  ) {
    throw new Error('RFC-64 legacy SWM boundary entries are duplicate or non-canonical');
  }
  return Object.freeze({ version: 1, entries: Object.freeze(entries) });
}

function encodeRfc64LegacySwmRepublishedMarkerV1(
  entry: Readonly<Rfc64LegacySwmBoundaryEntryV1>,
): Uint8Array {
  const marker: Rfc64LegacySwmRepublishedMarkerV1 = Object.freeze({
    version: 1,
    contextGraphId: entry.contextGraphId,
    kaUal: entry.kaUal,
  });
  return UTF8_ENCODER.encode(`${JSON.stringify(marker)}\n`);
}

function encodeRfc64LateLegacySwmBoundaryEntryV1(
  entry: Readonly<Rfc64LateLegacySwmBoundaryEntryV1>,
): string {
  return JSON.stringify({
    version: 1,
    contextGraphId: entry.contextGraphId,
    kaUal: entry.kaUal,
    shareOperationId: entry.shareOperationId,
    assertionVersion: entry.assertionVersion,
  });
}

function parseRfc64LateLegacySwmBoundaryEntryV1(
  encoded: string,
): Readonly<Rfc64LateLegacySwmBoundaryEntryV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (cause) {
    throw new Error('RFC-64 late legacy SWM boundary marker is not valid JSON', { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RFC-64 late legacy SWM boundary marker is malformed');
  }
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).sort().join('\n')
      !== 'assertionVersion\ncontextGraphId\nkaUal\nshareOperationId\nversion'
    || value.version !== 1
    || typeof value.contextGraphId !== 'string'
    || typeof value.kaUal !== 'string'
    || typeof value.shareOperationId !== 'string'
    || typeof value.assertionVersion !== 'string'
  ) {
    throw new Error('RFC-64 late legacy SWM boundary marker has unknown fields');
  }
  assertContextGraphIdV1(
    value.contextGraphId,
    'RFC-64 late legacy SWM boundary contextGraphId',
  );
  const entry = Object.freeze({
    version: 1,
    contextGraphId: value.contextGraphId,
    kaUal: assertCanonicalDeterministicUalV1(value.kaUal).ual,
    shareOperationId: value.shareOperationId,
    assertionVersion: assertPositiveDecimalU64V1(value.assertionVersion),
  } satisfies Rfc64LateLegacySwmBoundaryEntryV1);
  assertSwmAuthorInventoryShareOperationIdV1(entry.shareOperationId);
  if (encoded !== encodeRfc64LateLegacySwmBoundaryEntryV1(entry)) {
    throw new Error('RFC-64 late legacy SWM boundary marker is not canonical');
  }
  return entry;
}

function rfc64LateLegacySwmBoundaryMarkerQuadV1(
  entry: Readonly<Rfc64LateLegacySwmBoundaryEntryV1>,
): Quad {
  const encoded = encodeRfc64LateLegacySwmBoundaryEntryV1(entry);
  const digest = createHash('sha256').update(encoded).digest('hex');
  return Object.freeze({
    graph: RFC64_LEGACY_SWM_LATE_MARKER_GRAPH_V1,
    subject: `${RFC64_LEGACY_SWM_LATE_MARKER_SUBJECT_PREFIX_V1}${digest}`,
    predicate: RFC64_LEGACY_SWM_LATE_MARKER_PREDICATE_V1,
    object: JSON.stringify(encoded),
  });
}

function rfc64LegacySwmRepublishedPathV1(
  entry: Readonly<Rfc64LegacySwmBoundaryEntryV1>,
): string {
  const digest = createHash('sha256')
    .update(entry.contextGraphId)
    .update('\u0000')
    .update(entry.kaUal)
    .digest('hex');
  return `${RFC64_LEGACY_SWM_REPUBLISHED_PREFIX_V1}/${digest}.json`;
}

function compareEntries(
  left: Readonly<Rfc64LegacySwmBoundaryEntryV1>,
  right: Readonly<Rfc64LegacySwmBoundaryEntryV1>,
): number {
  return left.contextGraphId.localeCompare(right.contextGraphId)
    || left.kaUal.localeCompare(right.kaUal);
}

function compareLateEntries(
  left: Readonly<Rfc64LateLegacySwmBoundaryEntryV1>,
  right: Readonly<Rfc64LateLegacySwmBoundaryEntryV1>,
): number {
  return compareEntries(left, right)
    || left.shareOperationId.localeCompare(right.shareOperationId);
}

function addRfc64OutstandingLegacySwmBoundaryEntryV1(
  byContextGraph: Rfc64LegacySwmBoundaryStateV1['entriesByContextGraph'],
  tracked: Rfc64OutstandingLegacySwmBoundaryEntryV1,
): void {
  const byUal = byContextGraph.get(tracked.entry.contextGraphId) ?? new Map();
  const entries = byUal.get(tracked.entry.kaUal) ?? [];
  entries.push(tracked);
  byUal.set(tracked.entry.kaUal, entries);
  byContextGraph.set(tracked.entry.contextGraphId, byUal);
}

function removeRfc64OutstandingLegacySwmBoundaryEntryV1(
  state: Rfc64LegacySwmBoundaryStateV1,
  contextGraphId: string,
  kaUal: string,
  markerSubject: string,
): void {
  const byUal = state.entriesByContextGraph.get(contextGraphId);
  const entries = byUal?.get(kaUal);
  if (byUal === undefined || entries === undefined) return;
  const retained = entries.filter(
    (candidate) => candidate.lateMarker?.subject !== markerSubject,
  );
  if (retained.length === entries.length) return;
  state.entryCount -= entries.length - retained.length;
  if (retained.length === 0) byUal.delete(kaUal);
  else byUal.set(kaUal, retained);
  if (byUal.size === 0) state.entriesByContextGraph.delete(contextGraphId);
}

function beginRfc64LegacySwmBoundaryPreparationV1(
  state: Rfc64LegacySwmBoundaryStateV1,
): void {
  if (state.activePreparations === 0) {
    state.preparationsDrained = new Promise<void>((resolve) => {
      state.resolvePreparationsDrained = resolve;
    });
  }
  state.activePreparations += 1;
}

function settleRfc64LegacySwmBoundaryPreparationV1(
  state: Rfc64LegacySwmBoundaryStateV1,
): void {
  if (state.activePreparations < 1) {
    throw new Error('RFC-64 legacy SWM boundary preparation settlement is unbalanced');
  }
  state.activePreparations -= 1;
  if (state.activePreparations !== 0) return;
  const resolve = state.resolvePreparationsDrained;
  state.resolvePreparationsDrained = undefined;
  resolve?.();
}

function assertPositiveDecimalU64V1(input: string): PositiveDecimalU64V1 {
  assertCanonicalDecimalU64(input, 'RFC-64 legacy SWM assertionVersion');
  if (BigInt(input) < 1n) {
    throw new Error('RFC-64 legacy SWM assertionVersion must be positive');
  }
  return input as PositiveDecimalU64V1;
}

async function mutateRfc64LegacySwmBoundaryV1<T>(
  state: Rfc64LegacySwmBoundaryStateV1,
  mutation: () => Promise<T>,
): Promise<T> {
  const result = state.mutationTail.then(mutation, mutation);
  state.mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

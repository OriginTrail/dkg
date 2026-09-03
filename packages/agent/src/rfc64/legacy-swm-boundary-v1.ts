// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

import {
  assertCanonicalDeterministicUalV1,
  assertContextGraphIdV1,
  assertSafeIri,
  type CanonicalDeterministicUalV1,
  type ContextGraphIdV1,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';

import { createRfc64DurableFileStoreV1 } from './durable-file-store-v1.js';

const RFC64_LEGACY_SWM_CAPTURE_PATH_V1 = 'legacy-swm-boundary-v1/capture.json';
const RFC64_LEGACY_SWM_REPUBLISHED_PREFIX_V1 =
  'legacy-swm-boundary-v1/republished';
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

interface Rfc64LegacySwmBoundaryStateV1 {
  readonly durableFiles: ReturnType<typeof createRfc64DurableFileStoreV1>;
  readonly entriesByContextGraph: Map<string, Set<string>>;
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

  const entriesByContextGraph = new Map<string, Set<string>>();
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
    const entries = entriesByContextGraph.get(entry.contextGraphId) ?? new Set<string>();
    entries.add(entry.kaUal);
    entriesByContextGraph.set(entry.contextGraphId, entries);
  }
  rfc64LegacySwmBoundaryStatesV1.set(owner, {
    durableFiles,
    entriesByContextGraph,
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
 * Retire only captured historical entries that reached an exact, verified
 * catalog successor through the normal 10.0.16 authoring path.
 */
export async function markRfc64LegacySwmRepublishedV1(
  owner: object,
  contextGraphId: string,
  kaUals: readonly string[],
): Promise<void> {
  const state = rfc64LegacySwmBoundaryStatesV1.get(owner);
  const outstanding = state?.entriesByContextGraph.get(contextGraphId);
  if (state === undefined || outstanding === undefined || outstanding.size === 0) return;
  assertContextGraphIdV1(
    contextGraphId,
    'RFC-64 legacy SWM boundary contextGraphId',
  );
  const canonicalContextGraphId = contextGraphId;
  for (const rawUal of [...new Set(kaUals)].sort()) {
    if (!outstanding.has(rawUal)) continue;
    const kaUal = assertCanonicalDeterministicUalV1(rawUal).ual;
    const entry = Object.freeze({
      contextGraphId: canonicalContextGraphId,
      kaUal,
    });
    await state.durableFiles.putExactBytes({
      relativePath: rfc64LegacySwmRepublishedPathV1(entry),
      bytes: encodeRfc64LegacySwmRepublishedMarkerV1(entry),
      maxBytes: RFC64_LEGACY_SWM_REPUBLISHED_MAX_BYTES_V1,
      label: 'RFC-64 legacy SWM republished marker',
      kind: 'republished',
    });
    outstanding.delete(kaUal);
  }
  if (outstanding.size === 0) {
    state.entriesByContextGraph.delete(contextGraphId);
  }
}

async function captureRfc64LegacySwmBoundaryV1(
  store: TripleStore,
): Promise<Readonly<Rfc64LegacySwmBoundaryCaptureV1>> {
  const graphs = (await store.listGraphs({
    source: 'agent.rfc64.legacySwmBoundary.listGraphs',
    priority: 'background',
  })).filter((graph) => (
    graph.startsWith(CONTEXT_GRAPH_PREFIX) && graph.endsWith(SWM_META_SUFFIX)
  ));
  if (graphs.length > RFC64_LEGACY_SWM_META_GRAPH_LIMIT_V1) {
    throw new Error(
      `RFC-64 legacy SWM boundary exceeds metadata graph limit ` +
      `${RFC64_LEGACY_SWM_META_GRAPH_LIMIT_V1}`,
    );
  }

  const entries = new Map<string, Rfc64LegacySwmBoundaryEntryV1>();
  for (const metaGraph of graphs.sort()) {
    const remaining = RFC64_LEGACY_SWM_HEAD_LIMIT_V1 - entries.size;
    if (remaining < 1) {
      throw new Error(
        `RFC-64 legacy SWM boundary exceeds head limit ` +
        `${RFC64_LEGACY_SWM_HEAD_LIMIT_V1}`,
      );
    }
    const result = await store.query(
      `SELECT DISTINCT ?head ?ual ?contextGraphId WHERE { ` +
      `GRAPH <${assertSafeIri(metaGraph)}> { ` +
      `?head <${KA_UAL}> ?ual ; <${SHARE_OPERATION_ID}> ?shareId . ` +
      `?operation <${RDF_TYPE}> <${WORKSPACE_OPERATION}> ; ` +
      `<${KA_UAL}> ?ual ; <${SHARE_OPERATION_ID}> ?shareId ; ` +
      `<${CONTEXT_GRAPH_ID}> ?contextGraphId . ` +
      `FILTER(STRENDS(STR(?head), ${JSON.stringify(SWM_HEAD_SUFFIX)})) ` +
      `} } LIMIT ${remaining + 1}`,
      {
        source: 'agent.rfc64.legacySwmBoundary.readHeads',
        priority: 'background',
      },
    );
    if (result.type !== 'bindings') {
      throw new Error('RFC-64 legacy SWM boundary query did not return bindings');
    }
    if (result.bindings.length > remaining) {
      throw new Error(
        `RFC-64 legacy SWM boundary exceeds head limit ` +
        `${RFC64_LEGACY_SWM_HEAD_LIMIT_V1}`,
      );
    }
    for (const row of result.bindings) {
      const head = row['head'];
      const rawUal = row['ual'];
      const rawContextGraphId = row['contextGraphId'];
      if (head === undefined || rawUal === undefined || rawContextGraphId === undefined) {
        throw new Error('RFC-64 legacy SWM boundary returned an incomplete head');
      }
      const contextGraphId = decodeRfc64BindingValueV1(rawContextGraphId);
      assertContextGraphIdV1(
        contextGraphId,
        'RFC-64 legacy SWM boundary contextGraphId',
      );
      const kaUal = assertCanonicalDeterministicUalV1(rawUal).ual;
      if (head !== `${kaUal}${SWM_HEAD_SUFFIX}`) {
        throw new Error(`RFC-64 legacy SWM head identity differs for ${kaUal}`);
      }
      entries.set(`${contextGraphId}\u0000${kaUal}`, Object.freeze({
        contextGraphId,
        kaUal,
      }));
    }
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

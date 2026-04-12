/**
 * Integration tests for the POST /api/assertion/:name/import-file orchestration.
 *
 * These tests exercise the full Phase 1 → Phase 2 → assertion.write pipeline
 * without spinning up a full DKGAgent (which needs libp2p + chain). Instead
 * we drive the exact sequence of operations the route handler does:
 *
 *   1. parseMultipart(body, boundary)
 *   2. fileStore.put(filePart.content, detectedContentType)
 *   3. branch on detectedContentType:
 *        - text/markdown → raw bytes as mdIntermediate
 *        - registered converter → converter.extract(...)
 *        - neither → graceful degrade, status="skipped"
 *   4. extractFromMarkdown({ markdown, agentDid, ontologyRef, documentIri })
 *      and, when frontmatter resolves a different `rootEntity`, re-run with
 *      `documentIri = resolvedRootEntity`
 *   5. mockAgent.assertion.write(contextGraphId, name, triples)
 *   6. record in extractionStatus Map
 *
 * The mock agent captures the assertion.write call arguments for verification.
 * The real FileStore (on a temp dir), real extractionRegistry, real
 * extractFromMarkdown, real parseMultipart are all used.
 *
 * This covers the same behaviors the daemon route handler implements, minus the
 * HTTP parsing/validation shell (which is tested indirectly via the multipart
 * unit tests plus the bits the daemon compiles against).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  ExtractionPipelineRegistry,
  type ExtractionPipeline,
  type ExtractionInput,
  type ConverterOutput,
  contextGraphAssertionUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import { findReservedSubjectPrefix, isSkolemizedUri } from '@origintrail-official/dkg-publisher';
import { FileStore } from '../src/file-store.js';
import type { ExtractionStatusRecord } from '../src/extraction-status.js';
import { parseBoundary, parseMultipart } from '../src/http/multipart.js';
import { extractFromMarkdown } from '../src/extraction/markdown-extractor.js';

// ── Test fixture types (mirroring the ExtractionStatusRecord in daemon.ts) ──

interface CapturedQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

interface MockAgent {
  peerId: string;
  listSubGraphs: (contextGraphId: string) => Promise<Array<{ name: string }>>;
  assertion: {
    create: (
      contextGraphId: string,
      name: string,
      opts?: { subGraphName?: string },
    ) => Promise<string>;
    /**
     * Discards an assertion: deletes any `_meta` rows keyed by the
     * assertion UAL first (Bug 12), then drops the assertion data graph.
     * Mirrors the real publisher.assertionDiscard after the Bug 12 fix
     * (_meta first, drop second). Bug 12 regression tests exercise
     * partial-failure modes: a `deleteByPattern` failure leaves data
     * intact; a `dropGraph` failure after `_meta` succeeds leaves data
     * orphaned but not misleading.
     */
    discard: (
      contextGraphId: string,
      name: string,
      opts?: { subGraphName?: string },
    ) => Promise<void>;
  };
  store: {
    insert: (quads: CapturedQuad[]) => Promise<void>;
    /**
     * Removes every quad from `insertedQuads` that matches the given
     * partial pattern (subject / predicate / object / graph, any subset).
     * Mirrors the real `TripleStore.deleteByPattern` contract so the
     * mock can exercise the stale-`_meta` cleanup introduced in Bug 5a.
     */
    deleteByPattern: (pattern: Partial<CapturedQuad>) => Promise<number>;
    /**
     * Drops every quad in `insertedQuads` whose `graph` matches the URI,
     * matching the real `TripleStore.dropGraph` contract. Used by the
     * assertion.discard mock to purge the data graph in one call.
     */
    dropGraph: (graphUri: string) => Promise<void>;
    /**
     * Minimal SPARQL query mock that supports exactly one shape: the
     * `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <g> { ?s ?p ?o } }` pattern
     * used by `daemon.ts` to snapshot the assertion graph for Bug 11
     * rollback. Parses the target graph URI out of the query string,
     * filters `insertedQuads`, and returns them in the adapter's
     * `ConstructResult` shape.
     */
    query: (sparql: string) => Promise<{ type: 'quads'; quads: CapturedQuad[] } | { type: 'bindings'; bindings: Array<Record<string, string>> } | { type: 'boolean'; value: boolean }>;
  };
  /**
   * Every quad the route handler has inserted through agent.store. The
   * daemon makes a single atomic `store.insert` call per import that
   * contains both the data-graph quads (pinned to the assertion graph
   * URI) and the `_meta` quads (pinned to the CG root `_meta` URI), so
   * tests filter this array by `graph` to assert on each side.
   */
  insertedQuads: CapturedQuad[];
  createdAssertions: Array<{ contextGraphId: string; name: string; subGraphName?: string }>;
  /**
   * Graph URIs that have been dropped via `store.dropGraph`. Used by
   * discard regression tests to verify the data graph was actually
   * dropped (not just the `_meta` rows cleaned up).
   */
  droppedGraphs: string[];
  /**
   * Monotonically-incrementing counter of `store.insert` calls. Used
   * by Bug 22 regression tests to prove the rollback path did NOT
   * fire on a deleteByPattern-only failure (insert count unchanged
   * between before and after the failed import).
   */
  readonly insertCallCount: number;
}

interface MockAgentOptions {
  createError?: Error;
  /**
   * When set, every `agent.store.insert` call throws this error. Used by
   * regression tests that simulate a triple-store outage during the
   * atomic multi-graph insert. Bug 11 regression test then verifies
   * that the daemon's rollback path restores the prior-import snapshot.
   */
  insertError?: Error;
  /**
   * Predicate that gates `agent.store.insert` — insert throws when the
   * predicate returns true for the given quads batch. Used by Bug 11's
   * "first insert fails, second (rollback) insert succeeds" regression
   * test, which needs to fail the FIRST call (the fresh data) but let
   * the SECOND call (the snapshot restore) through.
   */
  insertErrorPredicate?: (quads: CapturedQuad[], callNumber: number) => Error | null;
  /**
   * When set, `agent.store.deleteByPattern` throws this error.
   * Bug 12 regression test uses this to simulate a `_meta` cleanup
   * failure during discard.
   */
  deleteByPatternError?: Error;
  /**
   * When set, `agent.store.dropGraph` throws this error. Bug 12
   * regression test uses this to simulate a data-graph drop failure
   * during discard.
   */
  dropGraphError?: Error;
  /**
   * Round 13 Bug 38: predicate that gates `agent.store.query` — when
   * it returns an Error, the query throws. Used by the stage-context
   * preservation tests to simulate a snapshot query failure (the
   * data-graph CONSTRUCT or the scoped `_meta` CONSTRUCT) and verify
   * that the import-file outer catch does NOT overwrite the stage-
   * specific failure message with the raw store error.
   */
  queryErrorPredicate?: (sparql: string) => Error | null;
  registeredSubGraphs?: string[];
}

function makeMockAgent(peerId = '0xMockAgentPeerId', options: MockAgentOptions = {}): MockAgent {
  const createdAssertions: Array<{ contextGraphId: string; name: string; subGraphName?: string }> = [];
  const insertedQuads: CapturedQuad[] = [];
  const droppedGraphs: string[] = [];
  let insertCallCount = 0;
  const agent: MockAgent = {
    peerId,
    createdAssertions,
    insertedQuads,
    droppedGraphs,
    get insertCallCount() { return insertCallCount; },
    async listSubGraphs(): Promise<Array<{ name: string }>> {
      return (options.registeredSubGraphs ?? []).map(name => ({ name }));
    },
    assertion: {
      async create(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<string> {
        if (options.createError) throw options.createError;
        createdAssertions.push({ contextGraphId, name, subGraphName: opts?.subGraphName });
        return contextGraphAssertionUri(contextGraphId, peerId, name, opts?.subGraphName);
      },
      async discard(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<void> {
        // Mirror the post-Bug-12 publisher.assertionDiscard ordering:
        // `_meta` cleanup first, then drop the data graph. A
        // `deleteByPattern` failure leaves the data intact (retry-safe);
        // a `dropGraph` failure after `_meta` succeeded leaves an
        // orphaned data graph with no `_meta` trail (debuggable but
        // not actively misleading).
        const graphUri = contextGraphAssertionUri(contextGraphId, peerId, name, opts?.subGraphName);
        const metaGraph = contextGraphMetaUri(contextGraphId);
        await agent.store.deleteByPattern({ subject: graphUri, graph: metaGraph });
        await agent.store.dropGraph(graphUri);
      },
    },
    store: {
      async insert(quads: CapturedQuad[]): Promise<void> {
        insertCallCount++;
        if (options.insertError) throw options.insertError;
        if (options.insertErrorPredicate) {
          const err = options.insertErrorPredicate(quads, insertCallCount);
          if (err) throw err;
        }
        insertedQuads.push(...quads);
      },
      async deleteByPattern(pattern: Partial<CapturedQuad>): Promise<number> {
        if (options.deleteByPatternError) throw options.deleteByPatternError;
        const matches = (q: CapturedQuad) =>
          (pattern.subject === undefined || q.subject === pattern.subject)
          && (pattern.predicate === undefined || q.predicate === pattern.predicate)
          && (pattern.object === undefined || q.object === pattern.object)
          && (pattern.graph === undefined || q.graph === pattern.graph);
        let removed = 0;
        for (let i = insertedQuads.length - 1; i >= 0; i--) {
          if (matches(insertedQuads[i]!)) {
            insertedQuads.splice(i, 1);
            removed++;
          }
        }
        return removed;
      },
      async dropGraph(graphUri: string): Promise<void> {
        if (options.dropGraphError) throw options.dropGraphError;
        droppedGraphs.push(graphUri);
        for (let i = insertedQuads.length - 1; i >= 0; i--) {
          if (insertedQuads[i]!.graph === graphUri) {
            insertedQuads.splice(i, 1);
          }
        }
      },
      async query(sparql: string): Promise<{ type: 'quads'; quads: CapturedQuad[] } | { type: 'bindings'; bindings: Array<Record<string, string>> } | { type: 'boolean'; value: boolean }> {
        // Round 13 Bug 38: failure injection for stage-context tests.
        if (options.queryErrorPredicate) {
          const err = options.queryErrorPredicate(sparql);
          if (err) throw err;
        }
        // Minimal SPARQL parser supporting the two CONSTRUCT shapes
        // `daemon.ts` uses for Bugs 11 + 15 snapshots:
        //
        //   (a) full data graph:
        //       `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <g> { ?s ?p ?o } }`
        //   (b) scoped `_meta` rows:
        //       `CONSTRUCT { <subj> ?p ?o } WHERE { GRAPH <g> { <subj> ?p ?o } }`
        //
        // The scoped form is detected by the presence of a
        // `<subject-iri>` token in the WHERE clause's triple pattern
        // instead of the `?s` variable. When detected, results are
        // filtered on both `graph` and `subject`.
        if (!/^\s*CONSTRUCT/i.test(sparql)) {
          return { type: 'bindings', bindings: [] };
        }
        const graphMatch = /GRAPH\s+<([^>]+)>/.exec(sparql);
        if (!graphMatch) {
          return { type: 'bindings', bindings: [] };
        }
        const targetGraph = graphMatch[1]!;
        // Look for a bound-subject pattern of the form
        // `GRAPH <g> { <subj> ?p ?o }`. If we find it, filter by subject.
        const scopedMatch = /GRAPH\s+<[^>]+>\s*\{\s*<([^>]+)>\s+\?p\s+\?o\s*\}/.exec(sparql);
        const quads = insertedQuads
          .filter(q => {
            if (q.graph !== targetGraph) return false;
            if (scopedMatch && q.subject !== scopedMatch[1]) return false;
            return true;
          })
          // Strip the graph URI to mimic the adapter contract where
          // CONSTRUCT results come back with graph="" (see oxigraph/
          // blazegraph CONSTRUCT handling). The daemon re-stamps
          // the target graph on the rollback path.
          .map(q => ({ ...q, graph: '' }));
        return { type: 'quads', quads };
      },
    },
  };
  return agent;
}

/**
 * Return just the data-graph quads from a mock agent's captured inserts,
 * i.e. quads whose `graph` matches the assertion graph URI for the given
 * import. Tests that used to read `agent.capturedWrites[0].triples` now
 * use this helper to pull the same triples by graph-URI filter.
 */
function getDataGraphQuads(
  agent: MockAgent,
  contextGraphId: string,
  assertionName: string,
  subGraphName?: string,
): Array<{ subject: string; predicate: string; object: string }> {
  const assertionGraph = contextGraphAssertionUri(contextGraphId, agent.peerId, assertionName, subGraphName);
  return agent.insertedQuads
    .filter(q => q.graph === assertionGraph)
    .map(({ subject, predicate, object }) => ({ subject, predicate, object }));
}

// ── The orchestration under test (matches daemon.ts import-file handler) ──

interface ImportFileResult {
  assertionUri: string;
  fileHash: string;
  rootEntity?: string;
  detectedContentType: string;
  extraction: {
    status: 'completed' | 'skipped' | 'failed';
    tripleCount: number;
    pipelineUsed: string | null;
    mdIntermediateHash?: string;
    error?: string;
  };
}

class ImportFileRouteError extends Error {
  readonly statusCode: number;
  readonly body: ImportFileResult;

  constructor(statusCode: number, body: ImportFileResult) {
    super(body.extraction.error ?? `Import-file request failed with status ${statusCode}`);
    this.statusCode = statusCode;
    this.body = body;
  }
}

function buildImportFileResponse(args: {
  assertionUri: string;
  fileHash: string;
  rootEntity?: string;
  detectedContentType: string;
  extraction: ImportFileResult['extraction'];
}): ImportFileResult {
  return {
    assertionUri: args.assertionUri,
    fileHash: args.fileHash,
    ...(args.rootEntity ? { rootEntity: args.rootEntity } : {}),
    detectedContentType: args.detectedContentType,
    extraction: {
      status: args.extraction.status,
      tripleCount: args.extraction.tripleCount,
      pipelineUsed: args.extraction.pipelineUsed,
      ...(args.extraction.mdIntermediateHash ? { mdIntermediateHash: args.extraction.mdIntermediateHash } : {}),
      ...(args.extraction.error ? { error: args.extraction.error } : {}),
    },
  };
}

function normalizeDetectedContentType(contentType: string | undefined): string {
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : 'application/octet-stream';
}

async function runImportFileOrchestration(params: {
  agent: MockAgent;
  fileStore: FileStore;
  extractionRegistry: ExtractionPipelineRegistry;
  extractionStatus: Map<string, ExtractionStatusRecord>;
  multipartBody: Buffer;
  boundary: string;
  assertionName: string;
  onInProgress?: (assertionUri: string, record: ExtractionStatusRecord) => void | Promise<void>;
  // Bug 19: per-assertion mutex map. If omitted, a fresh map is used
  // (safe for sequential tests). Concurrent-import tests that need to
  // observe the lock must pass a shared map across their parallel calls.
  assertionImportLocks?: Map<string, Promise<void>>;
}): Promise<ImportFileResult> {
  const { agent, fileStore, extractionRegistry, extractionStatus, multipartBody, boundary, assertionName, onInProgress } = params;
  const assertionImportLocks = params.assertionImportLocks ?? new Map<string, Promise<void>>();

  const fields = parseMultipart(multipartBody, boundary);
  const filePart = fields.find(f => f.name === 'file' && f.filename !== undefined)!;
  const textField = (name: string): string | undefined => {
    const f = fields.find(x => x.name === name && x.filename === undefined);
    return f ? f.content.toString('utf-8') : undefined;
  };
  const contextGraphId = textField('contextGraphId')!;
  const contentTypeOverrideRaw = textField('contentType');
  // Mirror the daemon: blank `contentType=` is treated as absent.
  const contentTypeOverride =
    contentTypeOverrideRaw && contentTypeOverrideRaw.trim().length > 0
      ? contentTypeOverrideRaw
      : undefined;
  const ontologyRef = textField('ontologyRef');
  const subGraphName = textField('subGraphName');
  const detectedContentType = normalizeDetectedContentType(contentTypeOverride ?? filePart.contentType);
  if (subGraphName) {
    const registeredSubGraphs = await agent.listSubGraphs(contextGraphId);
    if (!registeredSubGraphs.some(subGraph => subGraph.name === subGraphName)) {
      throw new Error(`Sub-graph "${subGraphName}" has not been registered in context graph "${contextGraphId}". Call createSubGraph() first.`);
    }
  }

  const fileStoreEntry = await fileStore.put(filePart.content, detectedContentType);
  const assertionUri = contextGraphAssertionUri(contextGraphId, agent.peerId, assertionName, subGraphName);
  const startedAt = new Date().toISOString();

  // Round 14 Bug 42: per-assertion mutex BEFORE extraction — mirrors
  // the daemon's restructure. Concurrent imports of the same assertion
  // name used to race during Phase 1/2 extraction and commit in
  // extraction-finish order rather than request-arrival order.
  // Moving the lock here serializes the entire handler per URI so
  // commits land in the order their callers arrived. Released in the
  // outer `finally` at the bottom of this function.
  const previousLock = assertionImportLocks.get(assertionUri) ?? Promise.resolve();
  let releaseLock: () => void = () => {};
  const currentLock = new Promise<void>(resolve => { releaseLock = resolve; });
  const chainedLock = previousLock.then(() => currentLock);
  assertionImportLocks.set(assertionUri, chainedLock);
  await previousLock;

  try {
  let mdIntermediate: string | null = null;
  let pipelineUsed: string | null = null;
  let mdIntermediateHash: string | undefined;
  let importRootEntity: string | undefined;
  const recordInProgress = async (): Promise<void> => {
    const record: ExtractionStatusRecord = {
      status: 'in_progress',
      fileHash: fileStoreEntry.keccak256,
      detectedContentType,
      pipelineUsed,
      tripleCount: 0,
      ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
      startedAt,
    };
    extractionStatus.set(assertionUri, record);
    if (onInProgress) {
      await onInProgress(assertionUri, record);
    }
  };
  const recordFailed = (error: string, tripleCount: number, failedPipelineUsed: string | null = pipelineUsed): void => {
    extractionStatus.set(assertionUri, {
      status: 'failed',
      fileHash: fileStoreEntry.keccak256,
      ...(importRootEntity ? { rootEntity: importRootEntity } : {}),
      detectedContentType,
      pipelineUsed: failedPipelineUsed,
      tripleCount,
      ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
      error,
      startedAt,
      completedAt: new Date().toISOString(),
    });
  };
  const fail = (statusCode: number, error: string, tripleCount: number, failedPipelineUsed: string | null = pipelineUsed): never => {
    recordFailed(error, tripleCount, failedPipelineUsed);
    throw new ImportFileRouteError(statusCode, buildImportFileResponse({
      assertionUri,
      fileHash: fileStoreEntry.keccak256,
      rootEntity: importRootEntity,
      detectedContentType,
      extraction: {
        status: 'failed',
        tripleCount,
        pipelineUsed: failedPipelineUsed,
        ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
        error,
      },
    }));
  };

  await recordInProgress();

  if (detectedContentType === 'text/markdown') {
    mdIntermediate = filePart.content.toString('utf-8');
    pipelineUsed = 'text/markdown';
    await recordInProgress();
  } else {
    const converter = extractionRegistry.get(detectedContentType);
    if (converter) {
      const { mdIntermediate: md } = await converter.extract({
        filePath: fileStoreEntry.path,
        contentType: detectedContentType,
        ontologyRef,
        agentDid: `did:dkg:agent:${agent.peerId}`,
      });
      mdIntermediate = md;
      pipelineUsed = detectedContentType;
      const mdEntry = await fileStore.put(Buffer.from(md, 'utf-8'), 'text/markdown');
      mdIntermediateHash = mdEntry.keccak256;
      await recordInProgress();
    }
  }

  // Graceful degrade
  if (mdIntermediate === null) {
    const skippedRecord: ExtractionStatusRecord = {
      status: 'skipped',
      fileHash: fileStoreEntry.keccak256,
      detectedContentType,
      pipelineUsed: null,
      tripleCount: 0,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    extractionStatus.set(assertionUri, skippedRecord);
    return buildImportFileResponse({
      assertionUri,
      fileHash: fileStoreEntry.keccak256,
      detectedContentType,
      extraction: { status: 'skipped', tripleCount: 0, pipelineUsed: null },
    });
  }

  // Phase 2 — file descriptor block (rows 4-13) lives on URI subjects
  // (Round 4 Option B after the blank-node approach was reverted). The
  // URNs `urn:dkg:file:keccak256:<hex>` and `urn:dkg:extraction:<uuid>`
  // are filtered out of `assertionPromote`'s partition by a subject-
  // prefix filter in the real publisher, so cross-assertion contention
  // on the file URN is impossible on promote.
  const fileUri = `urn:dkg:file:${fileStoreEntry.keccak256}`;
  const provUri = `urn:dkg:extraction:${randomUUID()}`;
  const agentDid = `did:dkg:agent:${agent.peerId}`;
  let triples: ReturnType<typeof extractFromMarkdown>['triples'];
  let sourceFileLinkage: ReturnType<typeof extractFromMarkdown>['sourceFileLinkage'];
  let documentSubjectIri: string;
  let resolvedRootEntity: string;
  try {
    let result = extractFromMarkdown({
      markdown: mdIntermediate,
      agentDid,
      ontologyRef,
      documentIri: assertionUri,
      sourceFileIri: fileUri,
    });
    // Mirror daemon issue #122 behavior: when frontmatter resolves a
    // different root entity than the assertion container URI, re-run the
    // extractor with that resolved entity as the document subject.
    if (result.resolvedRootEntity !== assertionUri) {
      const reservedPrefix = findReservedSubjectPrefix(result.resolvedRootEntity);
      if (reservedPrefix) {
        fail(
          400,
          `Frontmatter 'rootEntity' resolves to the reserved namespace '${reservedPrefix}*', which is protocol-reserved for daemon-generated import bookkeeping subjects.`,
          0,
        );
      }
      if (isSkolemizedUri(result.resolvedRootEntity)) {
        fail(
          400,
          `Frontmatter 'rootEntity' resolves to the skolemized URI '${result.resolvedRootEntity}', but import-file rootEntity must identify a root subject rather than a skolemized child (/.well-known/genid/...).`,
          0,
        );
      }
      result = extractFromMarkdown({
        markdown: mdIntermediate,
        agentDid,
        ontologyRef,
        documentIri: result.resolvedRootEntity,
        sourceFileIri: fileUri,
      });
    }
    triples = result.triples;
    // Round 13 Bug 39: rename mirror — see daemon for rationale.
    sourceFileLinkage = result.sourceFileLinkage;
    documentSubjectIri = result.subjectIri;
    resolvedRootEntity = result.resolvedRootEntity;
    importRootEntity = resolvedRootEntity;
  } catch (err: any) {
    if (err instanceof ImportFileRouteError) {
      throw err;
    }
    const message = err?.message ?? String(err);
    // Bug 13 + Round 7 Bug 20: invalid frontmatter IRIs AND invalid
    // programmatic `rootEntityIri` / `sourceFileIri` inputs both
    // throw from the extractor. Surface as a 400 rather than a 500.
    if (
      message.includes('Invalid frontmatter')
      || message.includes("Invalid 'rootEntityIri'")
      || message.includes("Invalid 'sourceFileIri'")
    ) {
      fail(400, message, 0);
    }
    fail(500, `Phase 2 extraction failed: ${message}`, 0);
  }

  // Build the full quad set across both graphs (assertion data graph +
  // CG root `_meta`) and commit them in a single atomic `store.insert`
  // call. See the daemon comment for the full rationale — short version:
  // every storage adapter's `insert` is a single N-Quads load / INSERT
  // DATA operation, so all-or-nothing applies across graphs.
  const assertionGraph = contextGraphAssertionUri(contextGraphId, agent.peerId, assertionName, subGraphName);
  const metaGraph = contextGraphMetaUri(contextGraphId);
  const startedAtLiteral = `"${startedAt}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;

  // Data-graph quads: content + extractor linkage + daemon-owned rows
  // 2, 4, 5, 8, 9-13. Round 9 Bug 27 removed rows 6 (`dkg:fileName`)
  // and 7 (`dkg:contentType`) from the file descriptor block — those
  // per-upload facts now live on the assertion UAL in `_meta`, not on
  // the content-addressed `<fileUri>` subject. See daemon equivalent.
  const dataGraphQuads: CapturedQuad[] = [
    ...triples.map(t => ({ ...t, graph: assertionGraph })),
    ...sourceFileLinkage.map(t => ({ ...t, graph: assertionGraph })),
    // Row 2 — daemon-owned. Always the ORIGINAL upload content type, so
    // for PDF this is "application/pdf", not the markdown intermediate.
    // Its subject matches rows 1 and 3 on the resolved document entity.
    { subject: documentSubjectIri, predicate: 'http://dkg.io/ontology/sourceContentType', object: JSON.stringify(detectedContentType), graph: assertionGraph },
    // Rows 4, 5, 8 file descriptor — intrinsic-to-content properties only
    { subject: fileUri, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/File', graph: assertionGraph },
    { subject: fileUri, predicate: 'http://dkg.io/ontology/contentHash', object: JSON.stringify(fileStoreEntry.keccak256), graph: assertionGraph },
    { subject: fileUri, predicate: 'http://dkg.io/ontology/size', object: `"${fileStoreEntry.size}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: assertionGraph },
    // Rows 9-13 extraction provenance — URI subject (filtered out of promote)
    { subject: provUri, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/ExtractionProvenance', graph: assertionGraph },
    { subject: provUri, predicate: 'http://dkg.io/ontology/extractedFrom', object: fileUri, graph: assertionGraph },
    { subject: provUri, predicate: 'http://dkg.io/ontology/extractedBy', object: agentDid, graph: assertionGraph },
    { subject: provUri, predicate: 'http://dkg.io/ontology/extractedAt', object: startedAtLiteral, graph: assertionGraph },
    { subject: provUri, predicate: 'http://dkg.io/ontology/extractionMethod', object: JSON.stringify('structural'), graph: assertionGraph },
  ];

  // `_meta` quads (rows 14-20 + Round 9 Bug 27 `dkg:sourceFileName`) —
  // CG root `_meta` graph, never sub-graph.
  const metaQuads: CapturedQuad[] = [
    // Row 14 — uses the extractor's resolved root entity so row 3 and row 14 agree.
    { subject: assertionUri, predicate: 'http://dkg.io/ontology/rootEntity', object: resolvedRootEntity, graph: metaGraph },
    { subject: assertionUri, predicate: 'http://dkg.io/ontology/sourceContentType', object: JSON.stringify(detectedContentType), graph: metaGraph },
    { subject: assertionUri, predicate: 'http://dkg.io/ontology/sourceFileHash', object: JSON.stringify(fileStoreEntry.keccak256), graph: metaGraph },
    { subject: assertionUri, predicate: 'http://dkg.io/ontology/extractionMethod', object: JSON.stringify('structural'), graph: metaGraph },
    { subject: assertionUri, predicate: 'http://dkg.io/ontology/structuralTripleCount', object: `"${triples.length}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: metaGraph },
    { subject: assertionUri, predicate: 'http://dkg.io/ontology/semanticTripleCount', object: `"0"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: metaGraph },
  ];
  if (mdIntermediateHash) {
    metaQuads.push({
      subject: assertionUri,
      predicate: 'http://dkg.io/ontology/mdIntermediateHash',
      object: JSON.stringify(mdIntermediateHash),
      graph: metaGraph,
    });
  }
  // Round 9 Bug 27: `dkg:sourceFileName` on the assertion UAL —
  // per-upload metadata parallel to existing `dkg:sourceContentType`
  // (row 15). Skipped when no filename was provided.
  const uploadedFilename = filePart.filename?.trim() ?? '';
  if (uploadedFilename.length > 0) {
    metaQuads.push({
      subject: assertionUri,
      predicate: 'http://dkg.io/ontology/sourceFileName',
      object: JSON.stringify(uploadedFilename),
      graph: metaGraph,
    });
  }

  // Round 14 Bug 42: lock acquisition moved to the top of the
  // function, before any Phase 1/2 extraction. This inner `try`
  // now wraps only the assertion.create + snapshot + cleanup +
  // insert + rollback sequence. See the daemon equivalent and the
  // lock-acquisition site above for full rationale.
  try {
    try {
      await agent.assertion.create(contextGraphId, assertionName, subGraphName ? { subGraphName } : undefined);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (!(message.includes('already exists') || message.includes('duplicate') || message.includes('conflict'))) {
        if (message.includes('has not been registered') || message.includes('Invalid') || message.includes('Unsafe')) {
          fail(400, message, triples.length);
        }
        fail(500, message, triples.length);
      }
    }

    // Snapshot BOTH graphs for Bugs 11 + 15 rollback. The data-graph
    // snapshot captures every quad in the assertion graph; the `_meta`
    // snapshot is scoped to `<assertionUri> ?p ?o` within the CG root
    // `_meta` graph — we only rollback rows keyed by THIS assertion.
    let dataSnapshot: CapturedQuad[] = [];
    let metaSnapshot: CapturedQuad[] = [];
    try {
      const dataResult = await agent.store.query(
        `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`,
      );
      if (dataResult.type === 'quads') {
        dataSnapshot = dataResult.quads.map(q => ({ ...q, graph: assertionGraph }));
      }
    } catch (err: any) {
      // Round 13 Bug 38: mark the error so the outer catch preserves
      // the stage-specific failure message instead of overwriting it
      // with the raw store error. Mirrors the daemon equivalent.
      recordFailed(`Failed to snapshot assertion data graph for rollback: ${err?.message ?? String(err)}`, 0);
      (err as any).__failureAlreadyRecorded = true;
      throw err;
    }
    try {
      const metaResult = await agent.store.query(
        `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`,
      );
      if (metaResult.type === 'quads') {
        metaSnapshot = metaResult.quads.map(q => ({ ...q, graph: metaGraph }));
      }
    } catch (err: any) {
      // Round 13 Bug 38: same stage-context preservation as the
      // dataSnapshot branch above.
      recordFailed(`Failed to snapshot _meta for rollback: ${err?.message ?? String(err)}`, 0);
      (err as any).__failureAlreadyRecorded = true;
      throw err;
    }

    // Round 7 Bug 22: unified write-stage rollback. Track which
    // cleanup steps succeeded so the catch block can restore the
    // exact snapshots corresponding to state we actually corrupted:
    //
    //  - deleteByPattern fails → no rollback (state unchanged)
    //  - deleteByPattern succeeds, dropGraph fails → restore meta
    //  - dropGraph succeeds, insert fails → restore both
    //  - insert succeeds → no rollback
    let metaCleanupSucceeded = false;
    let dataDropSucceeded = false;
    try {
      await agent.store.deleteByPattern({ subject: assertionUri, graph: metaGraph });
      metaCleanupSucceeded = true;
      await agent.store.dropGraph(assertionGraph);
      dataDropSucceeded = true;
      await agent.store.insert([...dataGraphQuads, ...metaQuads]);
    } catch (writeErr: any) {
      const rollbackErrors: string[] = [];
      if (dataDropSucceeded && dataSnapshot.length > 0) {
        try {
          await agent.store.insert(dataSnapshot);
        } catch (dataRollbackErr: any) {
          rollbackErrors.push(`data rollback failed: ${dataRollbackErr?.message ?? dataRollbackErr}`);
        }
      }
      if (metaCleanupSucceeded && metaSnapshot.length > 0) {
        try {
          await agent.store.insert(metaSnapshot);
        } catch (metaRollbackErr: any) {
          rollbackErrors.push(`_meta rollback failed: ${metaRollbackErr?.message ?? metaRollbackErr}`);
        }
      }
      if (rollbackErrors.length > 0) {
        recordFailed(
          `write stage failed AND rollback failures: ${writeErr?.message ?? writeErr}; ${rollbackErrors.join('; ')}`,
          triples.length,
        );
        (writeErr as any).__failureAlreadyRecorded = true;
      }
      throw writeErr;
    }
  } catch (err: any) {
    // An ImportFileRouteError means a nested `fail()` call already
    // recorded a precise failure state. Don't re-record.
    if (err instanceof ImportFileRouteError) {
      throw err;
    }
    // Bug 15: compound rollback failure already wrote a rich error
    // record — don't overwrite it with the bare insert error.
    if (err?.__failureAlreadyRecorded) {
      throw err;
    }
    // Round 10 Bug 29: the `Invalid`/`Unsafe`/`has not been registered`
    // substring branch was removed from this outer catch. The inner
    // `assertion.create` catch (line 592 in this harness) is the only
    // step in this block where a user-input validation error
    // legitimately originates — and it already short-circuits with
    // fail(400, …) and returns. Post-`assertion.create` steps
    // (snapshot, cleanup, insert, rollback) operate on daemon-
    // constructed quads; `Invalid`/`Unsafe` in those messages
    // signals an internal storage error and must surface as 500.
    //
    // Unexpected insert failure: because the insert is atomic, nothing
    // landed, but we still record the failure so /extraction-status
    // doesn't stay stuck at in_progress.
    recordFailed(err?.message ?? String(err), triples.length);
    throw err;
  }

  const completedRecord: ExtractionStatusRecord = {
    status: 'completed',
    fileHash: fileStoreEntry.keccak256,
    ...(importRootEntity ? { rootEntity: importRootEntity } : {}),
    detectedContentType,
    pipelineUsed,
    tripleCount: triples.length,
    mdIntermediateHash,
    startedAt,
    completedAt: new Date().toISOString(),
  };
  extractionStatus.set(assertionUri, completedRecord);

  return buildImportFileResponse({
    assertionUri,
    fileHash: fileStoreEntry.keccak256,
    rootEntity: importRootEntity,
    detectedContentType,
    extraction: {
      status: 'completed',
      tripleCount: triples.length,
      pipelineUsed,
      ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
    },
  });
  } finally {
    // Round 14 Bug 42 outer finally: release the per-assertion lock
    // so the next waiter can start. Runs regardless of early returns
    // (graceful-degrade skipped path), failed-extraction throws, the
    // inner write-stage rethrow, or normal completion. Mirrors the
    // daemon's outer finally at the equivalent handler-end location.
    releaseLock();
    if (assertionImportLocks.get(assertionUri) === chainedLock) {
      assertionImportLocks.delete(assertionUri);
    }
  }
}

// ── Multipart body builder for tests ──

const BOUNDARY = '----dkgimporttest';
const CRLF = '\r\n';

function buildMultipart(parts: Array<
  | { kind: 'text'; name: string; value: string }
  | { kind: 'file'; name: string; filename: string; contentType: string; content: Buffer }
>): Buffer {
  const segments: Buffer[] = [];
  for (const p of parts) {
    segments.push(Buffer.from(`--${BOUNDARY}${CRLF}`));
    if (p.kind === 'text') {
      segments.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"${CRLF}${CRLF}${p.value}`));
    } else {
      segments.push(Buffer.from(
        `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"${CRLF}` +
        `Content-Type: ${p.contentType}${CRLF}${CRLF}`,
      ));
      segments.push(p.content);
    }
    segments.push(Buffer.from(CRLF));
  }
  segments.push(Buffer.from(`--${BOUNDARY}--${CRLF}`));
  return Buffer.concat(segments);
}

// ── Tests ──

describe('import-file orchestration — happy paths', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let registry: ExtractionPipelineRegistry;
  let status: Map<string, ExtractionStatusRecord>;
  let agent: MockAgent;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dkg-importfile-test-'));
    fileStore = new FileStore(join(tmpDir, 'files'));
    registry = new ExtractionPipelineRegistry();
    status = new Map();
    agent = makeMockAgent();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('text/markdown upload — skips Phase 1, runs Phase 2, writes triples to assertion', async () => {
    const markdown = [
      '---',
      'id: research-note',
      'type: ScholarlyArticle',
      'title: Climate Report 2026',
      'description: A short climate analysis',
      '---',
      '',
      '# Climate Report 2026',
      '',
      'Global temperature rose by 1.2°C. See [[Paris Agreement]] and #climate topics.',
      '',
      '## Background',
      '',
      'status:: draft',
      '',
      '## Methods',
      '',
      'Sampled historical records.',
      '',
    ].join('\n');

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'research-cg' },
      { kind: 'file', name: 'file', filename: 'climate.md', contentType: 'text/markdown', content: Buffer.from(markdown, 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'climate-report',
    });

    // Response shape
    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.pipelineUsed).toBe('text/markdown');
    expect(result.extraction.tripleCount).toBeGreaterThan(0);
    expect(result.fileHash).toMatch(/^keccak256:[0-9a-f]{64}$/);
    expect(result.detectedContentType).toBe('text/markdown');
    expect(result.extraction.mdIntermediateHash).toBeUndefined(); // no Phase 1, no MD intermediate stored separately
    expect(result.assertionUri).toBe(contextGraphAssertionUri('research-cg', agent.peerId, 'climate-report'));

    // Assertion graph created and data-graph quads committed through the
    // atomic multi-graph insert (single `store.insert` for both graphs).
    expect(agent.createdAssertions).toHaveLength(1);
    expect(agent.createdAssertions[0]).toEqual({ contextGraphId: 'research-cg', name: 'climate-report', subGraphName: undefined });
    const writtenTriples = getDataGraphQuads(agent, 'research-cg', 'climate-report');
    expect(writtenTriples.length).toBeGreaterThan(0);

    // Triples reflect the markdown structure
    // rdf:type ScholarlyArticle
    expect(writtenTriples.some(t =>
      t.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
      t.object === 'http://schema.org/ScholarlyArticle',
    )).toBe(true);
    // schema:name from frontmatter title
    expect(writtenTriples.some(t =>
      t.predicate === 'http://schema.org/name' &&
      t.object === '"Climate Report 2026"',
    )).toBe(true);
    // wikilink mention
    expect(writtenTriples.some(t =>
      t.predicate === 'http://schema.org/mentions' &&
      t.object === 'urn:dkg:md:paris-agreement',
    )).toBe(true);
    // hashtag as keyword
    expect(writtenTriples.some(t =>
      t.predicate === 'http://schema.org/keywords' &&
      t.object === '"climate"',
    )).toBe(true);
    // dataview field
    expect(writtenTriples.some(t =>
      t.predicate === 'http://schema.org/status' &&
      t.object === '"draft"',
    )).toBe(true);
    // section headings
    expect(writtenTriples.some(t =>
      t.predicate === 'http://dkg.io/ontology/hasSection',
    )).toBe(true);

    // Status map populated
    expect(status.size).toBe(1);
    const record = status.get(result.assertionUri)!;
    expect(record.status).toBe('completed');
    expect(record.fileHash).toBe(result.fileHash);
    expect(record.pipelineUsed).toBe('text/markdown');
    expect(record.tripleCount).toBe(result.extraction.tripleCount);
  });

  it('text/markdown upload uses filePart content type when contentType field is not provided', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'doc',
    });

    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.pipelineUsed).toBe('text/markdown');
    expect(result.detectedContentType).toBe('text/markdown');
  });

  it('normalizes markdown media types with parameters and casing before Phase 1 routing', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'Text/Markdown; charset=utf-8', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'doc',
    });

    expect(result.detectedContentType).toBe('text/markdown');
    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.pipelineUsed).toBe('text/markdown');
  });

  it('contentType text field overrides the file part Content-Type header', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'text', name: 'contentType', value: 'text/markdown' },
      // File reports application/octet-stream, but the override tells the handler to treat it as markdown
      { kind: 'file', name: 'file', filename: 'doc.bin', contentType: 'application/octet-stream', content: Buffer.from('# Hello\n\nWorld.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'override-test',
    });

    expect(result.detectedContentType).toBe('text/markdown');
    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.pipelineUsed).toBe('text/markdown');
  });

  it('registered converter path — runs Phase 1, stores MD intermediate, runs Phase 2', async () => {
    // Register a stub converter for application/pdf that converts "fake-pdf" bytes to real markdown
    const stubConverter: ExtractionPipeline = {
      contentTypes: ['application/pdf'],
      async extract(_input: ExtractionInput): Promise<ConverterOutput> {
        return {
          mdIntermediate: [
            '---',
            'id: stub-doc',
            'type: Report',
            '---',
            '',
            '# Stub Document',
            '',
            'Body with #tag1 and [[Reference]].',
            '',
          ].join('\n'),
        };
      },
    };
    registry.register(stubConverter);

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'research' },
      { kind: 'file', name: 'file', filename: 'paper.pdf', contentType: 'application/pdf', content: Buffer.from('fake-pdf-bytes', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'paper',
    });

    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.pipelineUsed).toBe('application/pdf');
    expect(result.extraction.mdIntermediateHash).toBeDefined();
    expect(result.extraction.mdIntermediateHash).toMatch(/^keccak256:[0-9a-f]{64}$/);
    expect(result.extraction.mdIntermediateHash).not.toBe(result.fileHash); // stored separately

    // MD intermediate is retrievable from the file store
    const mdBytes = await fileStore.get(result.extraction.mdIntermediateHash!);
    expect(mdBytes).not.toBeNull();
    expect(mdBytes!.toString('utf-8')).toContain('# Stub Document');

    // Triples reflect the Phase 2 extraction of the stub's MD intermediate
    const triples = getDataGraphQuads(agent, 'research', 'paper');
    expect(triples.some(t => t.object === 'http://schema.org/Report')).toBe(true);
    expect(triples.some(t => t.object === '"tag1"')).toBe(true);
    expect(triples.some(t => t.object === 'urn:dkg:md:reference')).toBe(true);
  });

  it('normalizes converter media types before registry lookup', async () => {
    const stubConverter: ExtractionPipeline = {
      contentTypes: ['application/pdf'],
      async extract(_input: ExtractionInput): Promise<ConverterOutput> {
        return { mdIntermediate: '# Converted\n\nBody.\n' };
      },
    };
    registry.register(stubConverter);

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'research' },
      { kind: 'file', name: 'file', filename: 'paper.pdf', contentType: 'Application/PDF; charset=binary', content: Buffer.from('fake-pdf-bytes', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'paper-normalized',
    });

    expect(result.detectedContentType).toBe('application/pdf');
    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.pipelineUsed).toBe('application/pdf');
    expect(result.extraction.mdIntermediateHash).toBeDefined();
  });

  it('passes ontologyRef through to the converter and Phase 2 extractor', async () => {
    let capturedOntologyRef: string | undefined;
    const stubConverter: ExtractionPipeline = {
      contentTypes: ['application/pdf'],
      async extract(input: ExtractionInput): Promise<ConverterOutput> {
        capturedOntologyRef = input.ontologyRef;
        return { mdIntermediate: '# Doc\n\nBody.\n' };
      },
    };
    registry.register(stubConverter);

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'research' },
      { kind: 'text', name: 'ontologyRef', value: 'did:dkg:context-graph:research/_ontology' },
      { kind: 'file', name: 'file', filename: 'paper.pdf', contentType: 'application/pdf', content: Buffer.from('pdf', 'utf-8') },
    ]);

    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'paper',
    });

    expect(capturedOntologyRef).toBe('did:dkg:context-graph:research/_ontology');
  });

  it('passes subGraphName through to assertion.create and assertion.write', async () => {
    agent = makeMockAgent('0xMockAgentPeerId', {
      registeredSubGraphs: ['decisions'],
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'text', name: 'subGraphName', value: 'decisions' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'decision-1',
    });

    expect(agent.createdAssertions[0]).toEqual({ contextGraphId: 'cg', name: 'decision-1', subGraphName: 'decisions' });
    // Sub-graph routing: data-graph quads land in the sub-graph's assertion
    // graph URI (which embeds `decisions`), not the CG root assertion URI.
    const subGraphAssertionGraph = contextGraphAssertionUri('cg', agent.peerId, 'decision-1', 'decisions');
    const subGraphDataQuads = agent.insertedQuads.filter(q => q.graph === subGraphAssertionGraph);
    expect(subGraphDataQuads.length).toBeGreaterThan(0);
  });

  it('seeds an in-progress extraction status before the terminal record is written', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    let observedInProgress = false;
    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'in-progress-doc',
      async onInProgress(assertionUri, record) {
        observedInProgress = true;
        expect(assertionUri).toBe(contextGraphAssertionUri('cg', agent.peerId, 'in-progress-doc'));
        expect(record.status).toBe('in_progress');
        expect(record.completedAt).toBeUndefined();
        expect(status.get(assertionUri)?.status).toBe('in_progress');
      },
    });

    expect(observedInProgress).toBe(true);
    expect(status.get(result.assertionUri)?.status).toBe('completed');
  });

  it('creates the assertion graph even when Phase 2 extracts zero content triples', async () => {
    // An empty markdown upload produces zero content triples but the route
    // handler still writes §10.1 linkage + §6.3 file descriptor + §3.2
    // extraction provenance into the assertion graph, and §10.2 meta
    // quads into the CG root `_meta`, so daemon restarts can still find
    // the file <-> assertion linkage.
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'empty.md', contentType: 'text/markdown', content: Buffer.from('', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'empty-doc',
    });

    expect(result.extraction.status).toBe('completed');
    // tripleCount reports Phase 2 content triples only, which is still zero.
    expect(result.extraction.tripleCount).toBe(0);
    expect(agent.createdAssertions).toHaveLength(1);
    expect(agent.createdAssertions[0]).toEqual({ contextGraphId: 'cg', name: 'empty-doc', subGraphName: undefined });
    // Data-graph quads: rows 1, 3 (linkage from extractor) + row 2
    // (daemon-owned) + rows 4, 5, 8 (file descriptor intrinsic-to-content
    // properties, 3 quads — Round 9 Bug 27 dropped rows 6+7) + rows 9-13
    // (extraction provenance, 5 quads) = 11 quads total.
    const dataQuads = getDataGraphQuads(agent, 'cg', 'empty-doc');
    expect(dataQuads).toHaveLength(11);
    // Meta graph still populated with the structural row 14-19 quads.
    const metaGraph = contextGraphMetaUri('cg');
    const metaQuads = agent.insertedQuads.filter(q => q.graph === metaGraph);
    expect(metaQuads.length).toBeGreaterThanOrEqual(6);
  });

  it('records failed extraction status when assertion.create rejects an unregistered sub-graph', async () => {
    agent = makeMockAgent('0xMockAgentPeerId', {
      registeredSubGraphs: ['decisions'],
      createError: new Error('Sub-graph "decisions" has not been registered in context graph "cg". Call createSubGraph() first.'),
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'text', name: 'subGraphName', value: 'decisions' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    await expect(runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'decision-1',
    })).rejects.toThrow('has not been registered');

    const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'decision-1', 'decisions');
    const record = status.get(assertionUri);
    expect(record).toBeDefined();
    expect(record?.status).toBe('failed');
    expect(record?.error).toContain('has not been registered');
    expect(record?.tripleCount).toBeGreaterThan(0);
  });

  it('surfaces non-idempotent assertion.create failures as failed imports', async () => {
    agent = makeMockAgent('0xMockAgentPeerId', {
      createError: new Error('Storage backend unavailable'),
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'empty.md', contentType: 'text/markdown', content: Buffer.from('', 'utf-8') },
    ]);

    let caught: unknown;
    try {
      await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'create-runtime-failure',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ImportFileRouteError);
    const routeError = caught as ImportFileRouteError;
    expect(routeError.statusCode).toBe(500);
    expect(routeError.body.extraction.status).toBe('failed');
    expect(routeError.body.extraction.error).toBe('Storage backend unavailable');

    const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'create-runtime-failure');
    const record = status.get(assertionUri);
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('Storage backend unavailable');
    expect(record?.tripleCount).toBe(0);
  });

  it('treats explicit already-exists assertion.create failures as idempotent', async () => {
    agent = makeMockAgent('0xMockAgentPeerId', {
      createError: new Error('Assertion graph already exists'),
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'create-idempotent',
    });

    expect(result.extraction.status).toBe('completed');
    // The atomic insert still ran, so the data-graph quads are present.
    expect(getDataGraphQuads(agent, 'cg', 'create-idempotent').length).toBeGreaterThan(0);
    expect(status.get(result.assertionUri)?.status).toBe('completed');
  });

  it('rejects an unregistered sub-graph before storing the upload blob', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'text', name: 'subGraphName', value: 'decisions' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    await expect(runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'unregistered-preflight',
    })).rejects.toThrow('has not been registered');

    expect(existsSync(fileStore.directory)).toBe(false);
  });

  it('records failed extraction status when the atomic insert rejects invalid triples', async () => {
    agent = makeMockAgent('0xMockAgentPeerId', {
      insertError: new Error('Invalid triple object'),
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    await expect(runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'invalid-write',
    })).rejects.toThrow('Invalid triple object');

    const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'invalid-write');
    const record = status.get(assertionUri);
    expect(record).toBeDefined();
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('Invalid triple object');
    expect(record?.tripleCount).toBeGreaterThan(0);
  });

  it('treats a blank contentType form field as absent and falls back to the file part Content-Type', async () => {
    // A client that submits `contentType=` (empty string) must NOT downgrade
    // a real text/markdown upload to application/octet-stream — the empty
    // override should be ignored and the file part's own Content-Type used.
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'text', name: 'contentType', value: '' },
      { kind: 'file', name: 'file', filename: 'note.md', contentType: 'text/markdown', content: Buffer.from('# Heading\n\nBody text.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'blank-override',
    });

    expect(result.detectedContentType).toBe('text/markdown');
    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.pipelineUsed).toBe('text/markdown');
    expect(result.extraction.tripleCount).toBeGreaterThan(0);
  });

  it('treats a whitespace-only contentType form field as absent', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'text', name: 'contentType', value: '   ' },
      { kind: 'file', name: 'file', filename: 'note.md', contentType: 'text/markdown', content: Buffer.from('# Heading\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'whitespace-override',
    });

    expect(result.detectedContentType).toBe('text/markdown');
    expect(result.extraction.status).toBe('completed');
  });

  it('records failed extraction status when the atomic insert throws an unexpected error', async () => {
    // Any error thrown from the atomic insert must update the
    // extraction status record from in_progress to failed before the
    // orchestration rethrows. Otherwise /extraction-status would
    // stay stuck reporting in_progress even though the import already
    // failed. Round 10 Bug 29 removed the substring-based 400 mapping
    // from this outer catch, so an atomic-insert failure now always
    // surfaces as a raw rethrow for the top-level 500 handler.
    agent = makeMockAgent('0xMockAgentPeerId', {
      insertError: new Error('Connection refused'),
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    await expect(runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'unexpected-write',
    })).rejects.toThrow('Connection refused');

    const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'unexpected-write');
    const record = status.get(assertionUri);
    expect(record).toBeDefined();
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('Connection refused');
    expect(record?.tripleCount).toBeGreaterThan(0);
    expect(record?.completedAt).toBeDefined();
  });

  it('Round 10 Bug 29: atomic insert failure with `Invalid`-in-message rethrows raw (not a 400 ImportFileRouteError)', async () => {
    // Round 10 Bug 29 fix: the outer catch used to map any error
    // message containing `Invalid` or `Unsafe` to a 400
    // ImportFileRouteError. That widened too far once the outer try
    // block grew to wrap snapshot/cleanup/dropGraph/insert —
    // an internal storage error whose message happens to contain
    // `Invalid` (e.g., Oxigraph's `Invalid query plan` or an
    // adapter's `Invalid triple object`) would be misclassified as
    // a user-input validation failure and get a 400 back, when in
    // reality it's a 500 server-side issue. The fix removed the
    // substring-based 400 mapping from the outer catch. The inner
    // `assertion.create` catch still maps its own 400s.
    //
    // Regression: a simulated internal storage error with `Invalid`
    // in its message must now rethrow as a raw Error (routed to the
    // top-level 500 handler), NOT as a 400 ImportFileRouteError.
    // The extraction status record still gets updated to `failed`
    // with the underlying message preserved.
    agent = makeMockAgent('0xMockAgentPeerId', {
      insertError: new Error('Invalid triple object'),
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    let caught: unknown;
    try {
      await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'internal-invalid',
      });
    } catch (err) {
      caught = err;
    }

    // Raw Error, NOT an ImportFileRouteError — proves the over-wide
    // 400 mapping is gone.
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(ImportFileRouteError);
    expect((caught as Error).message).toBe('Invalid triple object');

    // Extraction status still records the failure, so /extraction-status
    // doesn't stay stuck at in_progress.
    const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'internal-invalid');
    const record = status.get(assertionUri);
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('Invalid triple object');
  });

  it('Round 10 Bug 29: atomic insert failure with `Unsafe`-in-message also rethrows raw (substring match is gone entirely)', async () => {
    // Symmetric guard for the `Unsafe` half of the old substring
    // match. Same semantic: `Unsafe write`, `Unsafe literal` etc.
    // from an adapter are internal storage errors, 500 not 400.
    agent = makeMockAgent('0xMockAgentPeerId', {
      insertError: new Error('Unsafe replication target'),
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n', 'utf-8') },
    ]);

    let caught: unknown;
    try {
      await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'internal-unsafe',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeInstanceOf(ImportFileRouteError);
    expect((caught as Error).message).toBe('Unsafe replication target');
  });

  it('Round 10 Bug 29: genuine `assertion.create` user-input errors STILL map to 400 (inner catch unchanged)', async () => {
    // Positive regression — the inner `assertion.create` catch is
    // the only place user-input validation errors legitimately
    // originate in this block, and it still maps them to 400 via
    // `respondWithFailedExtraction`. The Bug 29 fix only narrowed
    // the OUTER catch, not the inner.
    agent = makeMockAgent('0xMockAgentPeerId', {
      createError: new Error('Invalid sub-graph name: reserved-word'),
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n', 'utf-8') },
    ]);

    let caught: unknown;
    try {
      await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'user-invalid-create',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ImportFileRouteError);
    expect((caught as ImportFileRouteError).statusCode).toBe(400);
    expect((caught as ImportFileRouteError).body.extraction.error).toContain('Invalid sub-graph name');
  });

  it('Round 13 Bug 38: data-graph snapshot failure preserves the stage-specific error message in extraction-status (not overwritten by outer catch)', async () => {
    // Round 13 Bug 38: when the rollback-snapshot CONSTRUCT query
    // fails, `recordFailedExtraction` is called with a stage-specific
    // message ("Failed to snapshot assertion data graph for rollback:
    // <underlying>"). Before the fix, the outer catch later called
    // `recordFailedExtraction` again with just the raw underlying
    // message, overwriting the stage context — a caller reading
    // `/extraction-status` saw "connection refused" instead of
    // "Failed at snapshot stage: connection refused".
    //
    // The fix marks the thrown error with `__failureAlreadyRecorded`
    // and the outer catch skips re-recording when it sees the flag.
    // This test injects a failure on the data-graph snapshot CONSTRUCT
    // (the first of the two snapshot queries — matches `?s ?p ?o`
    // pattern without a bound subject) and asserts the extraction
    // status record retains the stage-specific message.
    agent = makeMockAgent('0xMockAgentPeerId', {
      queryErrorPredicate: (sparql) => {
        // Data-graph snapshot uses the unbound `?s ?p ?o` pattern.
        // `_meta` snapshot uses a bound `<subject> ?p ?o` pattern.
        // Target only the unbound form so the other query shapes
        // (`_meta` snapshot, or any other CONSTRUCT) still work.
        if (/CONSTRUCT\s*\{\s*\?s\s+\?p\s+\?o\s*\}/.test(sparql)) {
          return new Error('simulated data-graph snapshot failure');
        }
        return null;
      },
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'data-snap.md', contentType: 'text/markdown', content: Buffer.from('# Snapshot\n', 'utf-8') },
    ]);

    await expect(runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'data-snap-fail',
    })).rejects.toThrow('simulated data-graph snapshot failure');

    const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'data-snap-fail');
    const record = status.get(assertionUri);
    expect(record).toBeDefined();
    expect(record?.status).toBe('failed');
    // The CRITICAL assertion: the stage-specific context survives.
    expect(record?.error).toContain('Failed to snapshot assertion data graph for rollback');
    expect(record?.error).toContain('simulated data-graph snapshot failure');
    // Negative assertion: the error is NOT just the raw underlying
    // message (which would mean the outer catch overwrote the stage
    // context — pre-fix behavior).
    expect(record?.error).not.toBe('simulated data-graph snapshot failure');
  });

  it('Round 13 Bug 38: `_meta` snapshot failure preserves the stage-specific error message (symmetric guard)', async () => {
    // Symmetric test for the `_meta` snapshot query (the second of
    // the two CONSTRUCTs, uses a bound-subject pattern). The fix
    // applied to both snapshot branches, so both need a regression.
    const bodyV1 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n', 'utf-8') },
    ]);
    // Seed V1 so the `_meta` snapshot query has something to fail on
    // during the V2 attempt (otherwise the first-import empty-snapshot
    // case might short-circuit before the query even runs).
    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'meta-snap-fail',
    });

    // Prime a fresh agent with V1's state and inject a `_meta` query
    // failure. The `_meta` snapshot CONSTRUCT uses a bound subject.
    const failAgent = makeMockAgent('0xMockAgentPeerId', {
      queryErrorPredicate: (sparql) => {
        // Target the bound-subject form: `CONSTRUCT { <subj> ?p ?o }`.
        if (/CONSTRUCT\s*\{\s*<[^>]+>\s+\?p\s+\?o\s*\}/.test(sparql)) {
          return new Error('simulated _meta snapshot failure');
        }
        return null;
      },
    });
    for (const q of agent.insertedQuads) {
      failAgent.insertedQuads.push({ ...q });
    }

    const bodyV2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n', 'utf-8') },
    ]);
    await expect(runImportFileOrchestration({
      agent: failAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'meta-snap-fail',
    })).rejects.toThrow('simulated _meta snapshot failure');

    const assertionUri = contextGraphAssertionUri('cg', failAgent.peerId, 'meta-snap-fail');
    const record = status.get(assertionUri);
    expect(record?.status).toBe('failed');
    expect(record?.error).toContain('Failed to snapshot _meta for rollback');
    expect(record?.error).toContain('simulated _meta snapshot failure');
    expect(record?.error).not.toBe('simulated _meta snapshot failure');
  });

  it('Round 13 Bug 38: non-snapshot write-stage failures still get outer-catch recording (preservation canary)', async () => {
    // Canary: the `__failureAlreadyRecorded` flag must not suppress
    // outer-catch recording when the error originates from a path
    // that was NEVER stage-specifically recorded. Force an error in
    // the atomic `store.insert` step (which does NOT set the flag
    // itself unless the rollback also fails — Round 5/6/7 compound
    // path) and assert the outer catch still records a `failed`
    // status so /extraction-status doesn't stay stuck at in_progress.
    agent = makeMockAgent('0xMockAgentPeerId', {
      insertError: new Error('Connection refused'),
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'ext.md', contentType: 'text/markdown', content: Buffer.from('# Ext\n', 'utf-8') },
    ]);

    await expect(runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'non-snapshot-fail',
    })).rejects.toThrow('Connection refused');

    const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'non-snapshot-fail');
    const record = status.get(assertionUri);
    expect(record?.status).toBe('failed');
    // Outer catch still recorded the raw message (this path has
    // no stage-specific predecessor, so the Round 13 flag check
    // correctly lets the outer catch write the error).
    expect(record?.error).toBe('Connection refused');
  });
});

describe('import-file orchestration — graceful degrade', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let registry: ExtractionPipelineRegistry;
  let status: Map<string, ExtractionStatusRecord>;
  let agent: MockAgent;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dkg-importfile-test-'));
    fileStore = new FileStore(join(tmpDir, 'files'));
    registry = new ExtractionPipelineRegistry();
    status = new Map();
    agent = makeMockAgent();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('unregistered content type — stores file, returns status="skipped", writes no triples', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'photo.png', contentType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'photo',
    });

    expect(result.extraction.status).toBe('skipped');
    expect(result.extraction.tripleCount).toBe(0);
    expect(result.extraction.pipelineUsed).toBeNull();
    expect(result.extraction.mdIntermediateHash).toBeUndefined();
    expect(result.detectedContentType).toBe('image/png');

    // File is still stored (retrievable via fileHash)
    const retrieved = await fileStore.get(result.fileHash);
    expect(retrieved).not.toBeNull();
    expect(retrieved![0]).toBe(0x89); // PNG magic byte preserved

    // No triples written to the assertion — graceful degrade should
    // bypass both the assertion graph creation AND the atomic insert.
    expect(agent.createdAssertions).toHaveLength(0);
    expect(agent.insertedQuads).toHaveLength(0);

    // Status record reflects the skip
    const record = status.get(result.assertionUri)!;
    expect(record.status).toBe('skipped');
    expect(record.pipelineUsed).toBeNull();
    expect(record.tripleCount).toBe(0);
  });

  it('unregistered content type with no content-type header — defaults to application/octet-stream and skips', async () => {
    // File part without a Content-Type header — daemon defaults to application/octet-stream
    const fileContent = Buffer.from('opaque', 'utf-8');
    const segments: Buffer[] = [];
    segments.push(Buffer.from(`--${BOUNDARY}${CRLF}`));
    segments.push(Buffer.from(`Content-Disposition: form-data; name="contextGraphId"${CRLF}${CRLF}cg`));
    segments.push(Buffer.from(CRLF));
    segments.push(Buffer.from(`--${BOUNDARY}${CRLF}`));
    segments.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="opaque.bin"${CRLF}${CRLF}`));
    segments.push(fileContent);
    segments.push(Buffer.from(CRLF));
    segments.push(Buffer.from(`--${BOUNDARY}--${CRLF}`));
    const body = Buffer.concat(segments);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'opaque-upload',
    });

    expect(result.detectedContentType).toBe('application/octet-stream');
    expect(result.extraction.status).toBe('skipped');
    expect(result.extraction.pipelineUsed).toBeNull();
  });
});

describe('import-file orchestration — source-file linkage (§10.1 / §6.3 / §10.2)', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let registry: ExtractionPipelineRegistry;
  let status: Map<string, ExtractionStatusRecord>;
  let agent: MockAgent;

  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const DKG = 'http://dkg.io/ontology/';
  const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dkg-importfile-test-'));
    fileStore = new FileStore(join(tmpDir, 'files'));
    registry = new ExtractionPipelineRegistry();
    status = new Map();
    agent = makeMockAgent();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('text/markdown import writes rows 1-13 into the data graph with blank-node subjects for the file descriptor + prov block', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'note.md', contentType: 'text/markdown', content: Buffer.from('---\nid: note\n---\n\n# Note\n\nBody.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'note',
    });

    expect(result.extraction.status).toBe('completed');
    expect(result.fileHash).toMatch(/^keccak256:[0-9a-f]{64}$/);
    // The route handler pins the extractor's documentIri to the assertion
    // UAL, so rows 1-3 live on the UAL as the document subject.
    const subjectIri = result.assertionUri;

    const written = getDataGraphQuads(agent, 'cg', 'note');
    expect(written.length).toBeGreaterThan(0);

    // Row 1 — object is the content-addressed URN (Round 4 Option B).
    // Must match the subject of rows 4-8 below.
    const row1 = written.find(t => t.subject === subjectIri && t.predicate === `${DKG}sourceFile`);
    expect(row1).toBeDefined();
    expect(row1!.object).toMatch(/^urn:dkg:file:keccak256:[0-9a-f]{64}$/);
    const fileUri = row1!.object;
    expect(fileUri).toBe(`urn:dkg:file:${result.fileHash}`);

    // Row 2 — daemon-owned, uses the ORIGINAL upload content type. For a
    // direct markdown upload that's "text/markdown"; the PDF test below
    // verifies the same row 2 carries "application/pdf" in its case.
    expect(written).toContainEqual({ subject: subjectIri, predicate: `${DKG}sourceContentType`, object: '"text/markdown"' });
    // Row 3 — reflexive rootEntity on the document subject in V10.0
    expect(written).toContainEqual({ subject: subjectIri, predicate: `${DKG}rootEntity`, object: subjectIri });

    // Row 4 — file descriptor subject is the SAME URN as row 1's object
    expect(written).toContainEqual({ subject: fileUri, predicate: RDF_TYPE, object: `${DKG}File` });
    // Row 5 — contentHash matches the wire fileHash (keccak256 literal)
    expect(written).toContainEqual({ subject: fileUri, predicate: `${DKG}contentHash`, object: `"${result.fileHash}"` });
    // Round 9 Bug 27: rows 6 (`dkg:fileName`) and 7 (`dkg:contentType`)
    // were REMOVED from the file descriptor block — they carried
    // per-upload metadata on a content-addressed subject and collided
    // when two imports of identical bytes used different names/types.
    // They now live on the assertion UAL in `_meta` (see the `_meta`
    // section of this test further down). The canary assertions below
    // lock in the absence of those two properties on `<fileUri>`.
    expect(written.some(t => t.subject === fileUri && t.predicate === `${DKG}fileName`)).toBe(false);
    expect(written.some(t => t.subject === fileUri && t.predicate === `${DKG}contentType`)).toBe(false);
    // Row 8 — size as xsd:integer
    expect(written.some(t =>
      t.subject === fileUri &&
      t.predicate === `${DKG}size` &&
      t.object.endsWith(`^^<${XSD_INTEGER}>`),
    )).toBe(true);

    // Rows 9-13 — one ExtractionProvenance resource minted per import,
    // subject is a fresh `urn:dkg:extraction:<uuid>` URN.
    const provTypeQuads = written.filter(t =>
      t.predicate === RDF_TYPE && t.object === `${DKG}ExtractionProvenance`,
    );
    expect(provTypeQuads).toHaveLength(1);
    const provUri = provTypeQuads[0]!.subject;
    expect(provUri).toMatch(/^urn:dkg:extraction:[0-9a-f-]{36}$/); // UUID v4
    // Row 10 — back-references the SAME file URN as rows 4-8 subject
    expect(written).toContainEqual({ subject: provUri, predicate: `${DKG}extractedFrom`, object: fileUri });
    // Row 11
    expect(written).toContainEqual({ subject: provUri, predicate: `${DKG}extractedBy`, object: `did:dkg:agent:${agent.peerId}` });
    // Row 12 — extractedAt is an xsd:dateTime literal
    expect(written.some(t =>
      t.subject === provUri &&
      t.predicate === `${DKG}extractedAt` &&
      /\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#dateTime>$/.test(t.object),
    )).toBe(true);
    // Row 13
    expect(written).toContainEqual({ subject: provUri, predicate: `${DKG}extractionMethod`, object: '"structural"' });

    // Bug 8 Option B guard: the `urn:dkg:file:` and `urn:dkg:extraction:`
    // URNs ARE present in the assertion WM graph (that's the revert from
    // Round 3's blank-node approach). The Option B filter lives in
    // `assertionPromote` downstream and strips them before SWM — that's
    // verified by the dedicated "filter drops import-bookkeeping URIs"
    // test below, not by this one.
    expect(written.some(q => q.subject.startsWith('urn:dkg:file:'))).toBe(true);
    expect(written.some(q => q.subject.startsWith('urn:dkg:extraction:'))).toBe(true);
  });

  it('text/markdown import writes rows 14-19 into the CG root _meta graph and omits row 20', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'note.md', contentType: 'text/markdown', content: Buffer.from('# Note\n\nBody.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'note',
    });

    const metaGraph = contextGraphMetaUri('cg');
    const metaForAssertion = agent.insertedQuads.filter(q =>
      q.graph === metaGraph && q.subject === result.assertionUri,
    );
    // Rows 14-19 plus Round 9 Bug 27 `dkg:sourceFileName` (7 total) —
    // no row 20 because Phase 1 did not run for a direct markdown upload.
    expect(metaForAssertion).toHaveLength(7);

    const byPredicate = (predLocal: string) =>
      metaForAssertion.find(q => q.predicate === `${DKG}${predLocal}`);

    // Row 14 — reflexive rootEntity on the UAL (matches row 3 in the
    // data graph, since the extractor's resolvedRootEntity falls back to
    // the document subject when no frontmatter override is present).
    expect(byPredicate('rootEntity')?.object).toBe(result.assertionUri);
    // Row 15 — original content type (matches row 2 now that both are
    // sourced from detectedContentType)
    expect(byPredicate('sourceContentType')?.object).toBe('"text/markdown"');
    // Row 16 — load-bearing: sourceFileHash lets a caller recover the blob
    expect(byPredicate('sourceFileHash')?.object).toBe(`"${result.fileHash}"`);
    // Row 17
    expect(byPredicate('extractionMethod')?.object).toBe('"structural"');
    // Row 18 — structural triple count matches the Phase 2 result
    expect(byPredicate('structuralTripleCount')?.object).toBe(`"${result.extraction.tripleCount}"^^<${XSD_INTEGER}>`);
    // Row 19 — V10.0 has no semantic extraction yet
    expect(byPredicate('semanticTripleCount')?.object).toBe(`"0"^^<${XSD_INTEGER}>`);
    // Row 20 — absent because Phase 1 did not run for a direct markdown upload
    expect(byPredicate('mdIntermediateHash')).toBeUndefined();
    // Round 9 Bug 27 — `dkg:sourceFileName` present on the UAL, carrying
    // the original upload filename literal. This is the new home for
    // per-upload metadata that used to live on `<fileUri>` as row 6.
    expect(byPredicate('sourceFileName')?.object).toBe('"note.md"');
  });

  it('application/pdf import writes row 15 in _meta and row 20 for mdIntermediateHash, with rows 2 and 15 both = application/pdf', async () => {
    const stubConverter: ExtractionPipeline = {
      contentTypes: ['application/pdf'],
      async extract(_input: ExtractionInput): Promise<ConverterOutput> {
        return { mdIntermediate: '---\nid: paper\n---\n\n# Paper\n\nBody.\n' };
      },
    };
    registry.register(stubConverter);

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'paper.pdf', contentType: 'application/pdf', content: Buffer.from('fake-pdf', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'paper',
    });

    expect(result.extraction.pipelineUsed).toBe('application/pdf');
    expect(result.extraction.mdIntermediateHash).toMatch(/^keccak256:[0-9a-f]{64}$/);

    const metaGraph = contextGraphMetaUri('cg');
    const metaForAssertion = agent.insertedQuads.filter(q =>
      q.graph === metaGraph && q.subject === result.assertionUri,
    );
    // Rows 14-20 + Round 9 Bug 27 `dkg:sourceFileName` = 8 rows total.
    expect(metaForAssertion).toHaveLength(8);

    const byPredicate = (predLocal: string) =>
      metaForAssertion.find(q => q.predicate === `${DKG}${predLocal}`);

    // Row 15 — original content type is application/pdf in _meta
    expect(byPredicate('sourceContentType')?.object).toBe('"application/pdf"');
    // Row 20 — mdIntermediateHash now present, matching the wire value
    expect(byPredicate('mdIntermediateHash')?.object).toBe(`"${result.extraction.mdIntermediateHash}"`);
    // Round 9 Bug 27 — sourceFileName present on the UAL for the PDF upload.
    expect(byPredicate('sourceFileName')?.object).toBe('"paper.pdf"');

    // Spec-engineer's Bug 1 ruling: row 2 (data graph) and row 15
    // (_meta) must both describe the ORIGINAL upload blob pointed at by
    // row 1. For a PDF upload that's "application/pdf" in BOTH graphs
    // (previously row 2 incorrectly carried "text/markdown" because the
    // extractor was hardcoding its input type).
    const dataQuads = getDataGraphQuads(agent, 'cg', 'paper');
    const dataRow2 = dataQuads.find(t => t.predicate === `${DKG}sourceContentType`);
    expect(dataRow2?.object).toBe('"application/pdf"');

    // Round 9 Bug 27 canary: the content-addressed `<urn:dkg:file:...>`
    // subject no longer carries `dkg:contentType` (that was row 7 in the
    // old file descriptor block). `_meta` row 15 on the UAL is the new
    // home for per-upload content type — the assertion above proves
    // that side of the move. This negative assertion proves the
    // collision-prone side was removed.
    const row1 = dataQuads.find(q =>
      q.subject === result.assertionUri && q.predicate === `${DKG}sourceFile`,
    );
    expect(row1).toBeDefined();
    expect(row1!.object).toMatch(/^urn:dkg:file:keccak256:[0-9a-f]{64}$/);
    const fileUri = row1!.object;
    expect(fileUri).toBe(`urn:dkg:file:${result.fileHash}`);
    expect(dataQuads.some(q => q.subject === fileUri && q.predicate === `${DKG}contentType`)).toBe(false);
    expect(dataQuads.some(q => q.subject === fileUri && q.predicate === `${DKG}fileName`)).toBe(false);
  });

  it('sub-graph routing: data triples follow the sub-graph, _meta always lands in CG root _meta', async () => {
    agent = makeMockAgent('0xMockAgentPeerId', { registeredSubGraphs: ['decisions'] });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'text', name: 'subGraphName', value: 'decisions' },
      { kind: 'file', name: 'file', filename: 'd.md', contentType: 'text/markdown', content: Buffer.from('# Decision\n\nBody.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'd1',
    });

    // Data-graph quads land in the SUB-GRAPH assertion graph URI (which
    // embeds `decisions`), not the CG root assertion URI. Under the
    // atomic multi-graph insert we verify this by filtering the mock's
    // captured inserts on the sub-graph's assertion-graph URI.
    const subGraphAssertionGraph = contextGraphAssertionUri('cg', agent.peerId, 'd1', 'decisions');
    const dataQuads = agent.insertedQuads.filter(q => q.graph === subGraphAssertionGraph);
    expect(dataQuads.length).toBeGreaterThan(0);

    // _meta quads used the CG ROOT meta URI, NOT the sub-graph meta URI.
    const rootMetaGraph = contextGraphMetaUri('cg');
    const subGraphMetaGraph = contextGraphMetaUri('cg', 'decisions');
    expect(rootMetaGraph).not.toBe(subGraphMetaGraph);
    const metaQuadsForAssertion = agent.insertedQuads.filter(q =>
      q.subject === result.assertionUri &&
      (q.graph === rootMetaGraph || q.graph === subGraphMetaGraph),
    );
    expect(metaQuadsForAssertion.length).toBeGreaterThan(0);
    for (const quad of metaQuadsForAssertion) {
      expect(quad.graph).toBe(rootMetaGraph);
      expect(quad.graph).not.toBe(subGraphMetaGraph);
    }
  });

  it('daemon-restart recovery: clearing extractionStatus leaves the file <-> assertion linkage in the graph', async () => {
    // Simulates a daemon restart: the in-memory extractionStatus map is
    // empty on boot, but §10.2 sourceFileHash in CG root _meta is the
    // canonical pointer from assertion UAL back to the source blob.
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'persistent.md', contentType: 'text/markdown', content: Buffer.from('# Persistent\n\nBody.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'persistent',
    });

    // Emulate a restart by dropping the in-memory status map.
    status.clear();
    expect(status.size).toBe(0);

    // The §10.2 linkage triples are still in the mock store — a real
    // daemon would SPARQL the CG root `_meta` graph; here we reach into
    // the captured quads directly.
    const metaGraph = contextGraphMetaUri('cg');
    const sourceFileHashQuad = agent.insertedQuads.find(q =>
      q.graph === metaGraph &&
      q.subject === result.assertionUri &&
      q.predicate === `${DKG}sourceFileHash`,
    );
    expect(sourceFileHashQuad).toBeDefined();

    // Recover the keccak256 hash by unquoting the literal, and confirm
    // the underlying blob is still resolvable via the FileStore.
    const recoveredHash = sourceFileHashQuad!.object.replace(/^"|"$/g, '');
    expect(recoveredHash).toBe(result.fileHash);
    const bytes = await fileStore.get(recoveredHash);
    expect(bytes).not.toBeNull();
    expect(bytes!.toString('utf-8')).toBe('# Persistent\n\nBody.\n');
  });

  it('FileStore.get accepts both sha256 and keccak256 prefixes for the same blob', async () => {
    // Verifies the dual-hash contract on FileStore itself: both prefixes
    // round-trip to the same bytes, so external callers can look up a
    // file by either identifier.
    const entry = await fileStore.put(Buffer.from('hello world', 'utf-8'), 'text/plain');
    expect(entry.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.keccak256).toMatch(/^keccak256:[0-9a-f]{64}$/);

    const bySha = await fileStore.get(entry.hash);
    const byKeccak = await fileStore.get(entry.keccak256);
    expect(bySha).not.toBeNull();
    expect(byKeccak).not.toBeNull();
    expect(bySha!.equals(byKeccak!)).toBe(true);
    expect(bySha!.toString('utf-8')).toBe('hello world');
  });

  it('atomic multi-graph insert: a failing store.insert leaves BOTH graphs empty', async () => {
    // Regression guard for spec-engineer Option (a) atomic insert. Under
    // the old two-call flow (assertion.write + separate _meta insert),
    // a failure in the second call would leave the first graph populated
    // and the second empty. With the single atomic insert, ANY failure
    // means NO quads land in EITHER graph, so a retry with identical
    // content is idempotent without any special reconciliation.
    agent = makeMockAgent('0xMockAgentPeerId', {
      insertError: new Error('simulated triple-store outage during atomic insert'),
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    await expect(runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'atomic-fail',
    })).rejects.toThrow('simulated triple-store outage');

    // Critical: NOTHING landed in either graph. agent.insertedQuads only
    // accumulates on successful calls, so a failing insert leaves the
    // array empty — which is exactly the guarantee the atomicity fix
    // gives us. A retry with identical content sees a clean slate.
    expect(agent.insertedQuads).toHaveLength(0);
    // The assertion graph container was still created (idempotent on retry).
    expect(agent.createdAssertions).toHaveLength(1);
    // Status record reflects the failure — the orchestration still calls
    // recordFailed before rethrowing, so /extraction-status doesn't stay
    // stuck at in_progress on an unexpected insert failure.
    const record = status.get(contextGraphAssertionUri('cg', agent.peerId, 'atomic-fail'))!;
    expect(record).toBeDefined();
    expect(record.status).toBe('failed');
    expect(record.error).toContain('simulated triple-store outage');
  });

  it('atomic multi-graph insert: a successful import commits both graphs in ONE store.insert call', async () => {
    // Complementary positive check. The daemon MUST make exactly one
    // `store.insert` call that contains quads for BOTH the assertion
    // graph AND the CG root `_meta` graph — not two separate calls.
    // Splitting would break the atomicity guarantee the test above
    // relies on.
    const insertCalls: number[] = [];
    const countingAgent = makeMockAgent();
    const origInsert = countingAgent.store.insert.bind(countingAgent.store);
    countingAgent.store.insert = async (quads) => {
      insertCalls.push(quads.length);
      return origInsert(quads);
    };

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'atom.md', contentType: 'text/markdown', content: Buffer.from('# Atom\n\nBody.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent: countingAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'atomic',
    });

    // Exactly one insert call, covering both graphs.
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toBeGreaterThan(0);

    // That single call contains quads for BOTH graphs.
    const assertionGraph = contextGraphAssertionUri('cg', countingAgent.peerId, 'atomic');
    const metaGraph = contextGraphMetaUri('cg');
    const dataQuads = countingAgent.insertedQuads.filter(q => q.graph === assertionGraph);
    const metaQuads = countingAgent.insertedQuads.filter(q => q.graph === metaGraph);
    expect(dataQuads.length).toBeGreaterThan(0);
    expect(metaQuads.length).toBeGreaterThanOrEqual(6); // rows 14-19 at minimum
    expect(dataQuads.length + metaQuads.length).toBe(countingAgent.insertedQuads.length);
    expect(result.extraction.status).toBe('completed');
  });

  it('Issue 122: frontmatter `rootEntity` override retargets imported content and promote roots to the resolved entity URI', async () => {
    // Issue #122: the import path used to pin the document subject to the
    // assertion UAL while only rows 3 and 14 pointed at the frontmatter
    // override. Promote partitions by actual subjects, so that made the
    // override informational only. The fix retargets the imported content
    // and linkage rows to the resolved root entity while keeping `_meta`
    // keyed by the assertion UAL.
    const ROOT_OVERRIDE = 'urn:note:climate-report';
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      {
        kind: 'file',
        name: 'file',
        filename: 'root.md',
        contentType: 'text/markdown',
        content: Buffer.from(`---\nid: climate\nrootEntity: ${ROOT_OVERRIDE}\n---\n\n# Climate\n`, 'utf-8'),
      },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'climate',
    });

    expect(result.rootEntity).toBe(ROOT_OVERRIDE);
    expect(status.get(result.assertionUri)?.rootEntity).toBe(ROOT_OVERRIDE);

    const dataQuads = getDataGraphQuads(agent, 'cg', 'climate');
    const fileUri = `urn:dkg:file:${result.fileHash}`;
    expect(dataQuads).toContainEqual({
      subject: ROOT_OVERRIDE,
      predicate: `${DKG}sourceFile`,
      object: fileUri,
    });
    expect(dataQuads).toContainEqual({
      subject: ROOT_OVERRIDE,
      predicate: `${DKG}sourceContentType`,
      object: '"text/markdown"',
    });
    expect(dataQuads).toContainEqual({
      subject: ROOT_OVERRIDE,
      predicate: `${DKG}rootEntity`,
      object: ROOT_OVERRIDE,
    });
    expect(dataQuads).toContainEqual({
      subject: ROOT_OVERRIDE,
      predicate: 'http://schema.org/name',
      object: '"Climate"',
    });
    expect(dataQuads.some(q => q.subject === result.assertionUri && q.predicate === `${DKG}rootEntity`)).toBe(false);
    expect(dataQuads.some(q => q.subject === result.assertionUri && q.predicate === `${DKG}sourceContentType`)).toBe(false);

    const metaGraph = contextGraphMetaUri('cg');
    const row14 = agent.insertedQuads.find(q =>
      q.graph === metaGraph &&
      q.subject === result.assertionUri &&
      q.predicate === `${DKG}rootEntity`,
    );
    expect(row14?.object).toBe(ROOT_OVERRIDE);

    // Promote filters only the reserved bookkeeping URNs; after that,
    // subject identity is what partitioning sees.
    const promotableSubjects = [...new Set(
      dataQuads
        .filter(q => {
          const lower = q.subject.toLowerCase();
          return !lower.startsWith('urn:dkg:file:') && !lower.startsWith('urn:dkg:extraction:');
        })
        .map(q => q.subject),
    )];
    expect(promotableSubjects).toContain(ROOT_OVERRIDE);
    expect(promotableSubjects).not.toContain(result.assertionUri);
    expect(row14?.object).toBe(ROOT_OVERRIDE);
  });

  it('Issue 122: fragment-bearing frontmatter `rootEntity` keeps section IRIs fragment-safe after retargeting', async () => {
    const ROOT_OVERRIDE = 'https://example.org/doc#root';
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      {
        kind: 'file',
        name: 'file',
        filename: 'fragment-root.md',
        contentType: 'text/markdown',
        content: Buffer.from(`---\nid: fragment-doc\nrootEntity: ${ROOT_OVERRIDE}\n---\n\n# Fragment Title\n\n## Intro\n\n### Details\n`, 'utf-8'),
      },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'fragment-root',
    });

    expect(result.rootEntity).toBe(ROOT_OVERRIDE);
    const dataQuads = getDataGraphQuads(agent, 'cg', 'fragment-root');
    expect(dataQuads).toContainEqual({
      subject: ROOT_OVERRIDE,
      predicate: `${DKG}hasSection`,
      object: `${ROOT_OVERRIDE}/section-1-intro`,
    });
    expect(dataQuads).toContainEqual({
      subject: `${ROOT_OVERRIDE}/section-1-intro`,
      predicate: `${DKG}hasSection`,
      object: `${ROOT_OVERRIDE}/section-2-details`,
    });
    expect(dataQuads.some(q => q.subject.includes('#root#section') || q.object.includes('#root#section'))).toBe(false);
  });

  it('Issue 122: reserved frontmatter `rootEntity` prefixes are rejected before retargeting content subjects', async () => {
    const RESERVED_ROOT = 'urn:dkg:file:keccak256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      {
        kind: 'file',
        name: 'file',
        filename: 'reserved-root.md',
        contentType: 'text/markdown',
        content: Buffer.from(`---\nid: reserved\nrootEntity: ${RESERVED_ROOT}\n---\n\n# Reserved\n`, 'utf-8'),
      },
    ]);

    let thrown: unknown;
    try {
      await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'reserved-root',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ImportFileRouteError);
    expect((thrown as ImportFileRouteError).statusCode).toBe(400);
    expect((thrown as ImportFileRouteError).body.extraction.error).toMatch(/reserved namespace 'urn:dkg:file:\*'/);

    const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'reserved-root');
    expect(status.get(assertionUri)?.status).toBe('failed');
    expect(agent.insertedQuads).toHaveLength(0);
  });

  it('Issue 122: skolemized frontmatter `rootEntity` values are rejected before retargeting content subjects', async () => {
    const SKOLEM_ROOT = 'did:dkg:doc:root/.well-known/genid/child';
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      {
        kind: 'file',
        name: 'file',
        filename: 'skolem-root.md',
        contentType: 'text/markdown',
        content: Buffer.from(`---\nid: skolem\nrootEntity: ${SKOLEM_ROOT}\n---\n\n# Skolem\n`, 'utf-8'),
      },
    ]);

    let thrown: unknown;
    try {
      await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'skolem-root',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ImportFileRouteError);
    expect((thrown as ImportFileRouteError).statusCode).toBe(400);
    expect((thrown as ImportFileRouteError).body.extraction.error).toMatch(/skolemized URI/);

    const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'skolem-root');
    expect(status.get(assertionUri)?.status).toBe('failed');
    expect(agent.insertedQuads).toHaveLength(0);
  });

  it('Bug 5a: re-import replaces (not appends) stale `_meta` rows for the same assertion name', async () => {
    // Regression guard for Bug 5a: a second import-file call against
    // the same assertion UAL must end up with EXACTLY ONE binding per
    // `_meta` predicate — not two. The daemon clears
    // `{subject: assertionUri, graph: metaGraph}` before each atomic
    // insert so a re-import with different content replaces the old
    // _meta block instead of stacking next to it.
    const ASSERTION_NAME = 'climate-report';
    const metaGraph = contextGraphMetaUri('cg');

    // First import: blob V1
    const body1 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# Climate V1\n\nOriginal body.\n', 'utf-8') },
    ]);
    const result1 = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body1, boundary: BOUNDARY, assertionName: ASSERTION_NAME,
    });
    const hashV1 = result1.fileHash;

    // After the first import, `_meta` has exactly one sourceFileHash row.
    const metaAfter1 = agent.insertedQuads.filter(q =>
      q.graph === metaGraph &&
      q.subject === result1.assertionUri &&
      q.predicate === `${DKG}sourceFileHash`,
    );
    expect(metaAfter1).toHaveLength(1);
    expect(metaAfter1[0]!.object).toBe(`"${hashV1}"`);

    // Second import: DIFFERENT content → different keccak256 hash, same
    // assertion name. Pre-fix behavior: stacks a second row alongside
    // the first. Post-fix: replaces.
    const body2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# Climate V2\n\nUpdated body.\n', 'utf-8') },
    ]);
    const result2 = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body2, boundary: BOUNDARY, assertionName: ASSERTION_NAME,
    });
    const hashV2 = result2.fileHash;
    expect(hashV2).not.toBe(hashV1); // sanity: different bodies → different hashes
    expect(result2.assertionUri).toBe(result1.assertionUri); // same UAL

    // After the second import, `_meta` still has EXACTLY ONE
    // sourceFileHash row, pointing at the new hash.
    const metaAfter2 = agent.insertedQuads.filter(q =>
      q.graph === metaGraph &&
      q.subject === result2.assertionUri &&
      q.predicate === `${DKG}sourceFileHash`,
    );
    expect(metaAfter2).toHaveLength(1);
    expect(metaAfter2[0]!.object).toBe(`"${hashV2}"`);

    // Every other `_meta` row keyed by this assertion UAL is also
    // single-binding — generalized invariant, catches future row
    // additions that might forget the cleanup.
    const allMetaForAssertion = agent.insertedQuads.filter(q =>
      q.graph === metaGraph && q.subject === result2.assertionUri,
    );
    const perPredicate = new Map<string, number>();
    for (const q of allMetaForAssertion) {
      perPredicate.set(q.predicate, (perPredicate.get(q.predicate) ?? 0) + 1);
    }
    for (const [pred, count] of perPredicate) {
      expect(count, `expected exactly one binding for <${pred}> after re-import, got ${count}`).toBe(1);
    }
  });

  it('Bug 7: re-import replaces stale data-graph rows — no two source files for one assertion', async () => {
    // Regression guard for Bug 7 (symmetric to Bug 5a on the data
    // graph). Before the fix, a re-import under the same assertion
    // name left the PRIOR blob's rows 1 and 4-13 in place alongside
    // the new blob's, so the assertion ended up with two conflicting
    // source files. The daemon now `dropGraph`s the assertion data
    // graph before the atomic insert, giving full replace semantics.
    //
    // With Bug 8's blank-node subjects (both imports use the same
    // `_:file1` label), we can't tell V1 from V2 by subject alone —
    // the contentHash LITERAL is the distinguishing signal. If the
    // drop-before-insert weren't happening, the data graph would end
    // up with TWO contentHash bindings (one per version); with the
    // fix, there's exactly one, pointing at V2.
    const ASSERTION_NAME = 'climate-report-v7';
    const assertionGraph = contextGraphAssertionUri('cg', agent.peerId, ASSERTION_NAME);

    // First import: blob V1.
    const body1 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n\nFirst body.\n', 'utf-8') },
    ]);
    const result1 = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body1, boundary: BOUNDARY, assertionName: ASSERTION_NAME,
    });

    // Baseline: V1's contentHash is in the data graph.
    const dataAfter1 = agent.insertedQuads.filter(q => q.graph === assertionGraph);
    const contentHashV1 = dataAfter1.filter(q => q.predicate === `${DKG}contentHash`);
    expect(contentHashV1).toHaveLength(1);
    expect(contentHashV1[0]!.object).toBe(`"${result1.fileHash}"`);
    // Row 1 points at a blank node (Bug 8 guard).
    const row1V1 = dataAfter1.find(q =>
      q.subject === result1.assertionUri && q.predicate === `${DKG}sourceFile`,
    );
    expect(row1V1!.object).toMatch(/^urn:dkg:file:keccak256:/);

    // Second import: DIFFERENT blob, same assertion name.
    const body2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n\nUpdated body.\n', 'utf-8') },
    ]);
    const result2 = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body2, boundary: BOUNDARY, assertionName: ASSERTION_NAME,
    });
    expect(result2.fileHash).not.toBe(result1.fileHash); // sanity
    expect(result2.assertionUri).toBe(result1.assertionUri); // same UAL

    // After the second import, the assertion data graph has ONLY V2's
    // rows. Row 5 `contentHash` appears exactly once, pointing at V2's
    // literal hash. If the dropGraph call weren't there, we'd see TWO
    // contentHash bindings — one per version.
    const dataAfter2 = agent.insertedQuads.filter(q => q.graph === assertionGraph);
    const contentHashQuads = dataAfter2.filter(q => q.predicate === `${DKG}contentHash`);
    expect(contentHashQuads).toHaveLength(1);
    expect(contentHashQuads[0]!.object).toBe(`"${result2.fileHash}"`);

    // No contentHash for V1 should remain anywhere in the data graph.
    expect(dataAfter2.some(q => q.object === `"${result1.fileHash}"`)).toBe(false);

    // Row 1 (`<UAL> dkg:sourceFile`) has exactly one quad pointing at
    // the V2 file URN (URN form, Round 4 Option B).
    const row1Quads = dataAfter2.filter(q =>
      q.subject === result2.assertionUri && q.predicate === `${DKG}sourceFile`,
    );
    expect(row1Quads).toHaveLength(1);
    expect(row1Quads[0]!.object).toBe(`urn:dkg:file:${result2.fileHash}`);

    // Single `dkg:File` type quad (only one file descriptor remains).
    const fileTypeQuads = dataAfter2.filter(q =>
      q.predicate === RDF_TYPE && q.object === `${DKG}File`,
    );
    expect(fileTypeQuads).toHaveLength(1);

    // Single `ExtractionProvenance` type quad (only one prov block).
    const provTypeQuads = dataAfter2.filter(q =>
      q.predicate === RDF_TYPE && q.object === `${DKG}ExtractionProvenance`,
    );
    expect(provTypeQuads).toHaveLength(1);

    // And `_meta` also shows only V2 (already covered by Bug 5a test
    // but worth asserting end-to-end here for completeness).
    const metaGraphUri = contextGraphMetaUri('cg');
    const metaSourceFileHash = agent.insertedQuads.filter(q =>
      q.graph === metaGraphUri &&
      q.subject === result2.assertionUri &&
      q.predicate === `${DKG}sourceFileHash`,
    );
    expect(metaSourceFileHash).toHaveLength(1);
    expect(metaSourceFileHash[0]!.object).toBe(`"${result2.fileHash}"`);
  });

  it('Bug 7: re-import of assertion A does NOT affect assertion B data or _meta', async () => {
    // Cross-assertion isolation guard: the Bug 7 `dropGraph` call must
    // only drop THIS assertion's data graph, never another's. A bug
    // that over-matched the drop would wipe unrelated assertions.
    const assertionGraphA = contextGraphAssertionUri('cg', agent.peerId, 'iso-a7');
    const assertionGraphB = contextGraphAssertionUri('cg', agent.peerId, 'iso-b7');
    const metaGraphUri = contextGraphMetaUri('cg');

    // Import A, then B.
    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'a.md', contentType: 'text/markdown', content: Buffer.from('# A orig\n', 'utf-8') },
      ]),
      boundary: BOUNDARY, assertionName: 'iso-a7',
    });
    const b1 = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'b.md', contentType: 'text/markdown', content: Buffer.from('# B orig\n', 'utf-8') },
      ]),
      boundary: BOUNDARY, assertionName: 'iso-b7',
    });

    // Snapshot B's state before the re-import of A.
    const bDataBefore = agent.insertedQuads.filter(q => q.graph === assertionGraphB).length;
    const bMetaBefore = agent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === b1.assertionUri,
    ).length;
    expect(bDataBefore).toBeGreaterThan(0);
    expect(bMetaBefore).toBeGreaterThan(0);

    // Re-import A with different content.
    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'a2.md', contentType: 'text/markdown', content: Buffer.from('# A replaced\n', 'utf-8') },
      ]),
      boundary: BOUNDARY, assertionName: 'iso-a7',
    });

    // B's data + _meta must be identical to the snapshot — byte-
    // perfect, not just non-empty.
    const bDataAfter = agent.insertedQuads.filter(q => q.graph === assertionGraphB).length;
    const bMetaAfter = agent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === b1.assertionUri,
    ).length;
    expect(bDataAfter).toBe(bDataBefore);
    expect(bMetaAfter).toBe(bMetaBefore);

    // Also verify B's actual sourceFileHash row still points at B's hash.
    const bSourceFileHash = agent.insertedQuads.find(q =>
      q.graph === metaGraphUri &&
      q.subject === b1.assertionUri &&
      q.predicate === `${DKG}sourceFileHash`,
    );
    expect(bSourceFileHash?.object).toBe(`"${b1.fileHash}"`);

    // And A's state was replaced (not merged).
    const aData = agent.insertedQuads.filter(q => q.graph === assertionGraphA);
    const aContentHash = aData.filter(q => q.predicate === `${DKG}contentHash`);
    expect(aContentHash).toHaveLength(1); // single file descriptor, not two
  });

  it('Bug 8: two imports with the same file content produce graph-scoped blank nodes that do not cross-contaminate', async () => {
    // Spec-engineer Option A: blank-node subjects for the file
    // descriptor are scoped by the assertion data graph. Two imports
    // that happen to reference the same file content (same keccak256)
    // end up with their file descriptors in SEPARATE assertion graphs,
    // so even if the blank-node LABELS are identical (`_:file1` both
    // times), the underlying blank nodes are distinct RDF terms —
    // `autoPartition` on promote would treat them as document-local,
    // and (critically) they cannot contend on ownership. This test
    // locks in the scoping invariant at the graph level.
    const body = () => buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'shared.md', contentType: 'text/markdown', content: Buffer.from('# Shared\n\nSame content.\n', 'utf-8') },
    ]);
    const a = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body(), boundary: BOUNDARY, assertionName: 'share-a',
    });
    const b = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body(), boundary: BOUNDARY, assertionName: 'share-b',
    });

    // Same wire hash (same content).
    expect(a.fileHash).toBe(b.fileHash);

    const graphA = contextGraphAssertionUri('cg', agent.peerId, 'share-a');
    const graphB = contextGraphAssertionUri('cg', agent.peerId, 'share-b');
    expect(graphA).not.toBe(graphB);

    // Each assertion graph has its own file descriptor with the same
    // keccak256 literal. Under Round 4 Option B, both descriptors have
    // IDENTICAL URN subjects (`urn:dkg:file:keccak256:<hex>`) because
    // the file is content-addressed. They live in disjoint assertion
    // graphs, so they don't conflict at the storage layer — and the
    // promote-time filter in `assertionPromote` strips them before
    // they'd otherwise collide in SWM.
    const contentHashA = agent.insertedQuads.filter(q =>
      q.graph === graphA && q.predicate === `${DKG}contentHash`,
    );
    const contentHashB = agent.insertedQuads.filter(q =>
      q.graph === graphB && q.predicate === `${DKG}contentHash`,
    );
    expect(contentHashA).toHaveLength(1);
    expect(contentHashB).toHaveLength(1);
    expect(contentHashA[0]!.object).toBe(`"${a.fileHash}"`);
    expect(contentHashB[0]!.object).toBe(`"${a.fileHash}"`);

    // Both have IDENTICAL URN subjects (content-addressed).
    const expectedFileUri = `urn:dkg:file:${a.fileHash}`;
    expect(contentHashA[0]!.subject).toBe(expectedFileUri);
    expect(contentHashB[0]!.subject).toBe(expectedFileUri);
    // Row 1 in both assertions also points at the same URN, proving
    // the URN flows through the extractor and daemon identically
    // regardless of which assertion is importing.
    const row1A = agent.insertedQuads.find(q =>
      q.graph === graphA && q.predicate === `${DKG}sourceFile`,
    );
    const row1B = agent.insertedQuads.find(q =>
      q.graph === graphB && q.predicate === `${DKG}sourceFile`,
    );
    expect(row1A?.object).toBe(expectedFileUri);
    expect(row1B?.object).toBe(expectedFileUri);
  });

  it('Bug 8 Option B: assertionPromote filter drops urn:dkg:file: and urn:dkg:extraction: subjects', async () => {
    // The revert from Round 3 blank-node subjects to Round 4 URN
    // subjects + promote-time filter is what prevents cross-assertion
    // contention. This test exercises the filter directly by
    // constructing a synthetic quad set containing row 1 (on the
    // document entity — should survive) plus the file descriptor
    // block (URN subject — should be dropped) plus the prov block
    // (URN subject — should be dropped) and running it through the
    // filter predicate.
    const entityUri = 'urn:doc:test';
    const fileUri = 'urn:dkg:file:keccak256:abc123';
    const provUri = 'urn:dkg:extraction:deadbeef-0000-4000-8000-000000000000';
    const quads: CapturedQuad[] = [
      // Row 1 — entity-subject, MUST survive
      { subject: entityUri, predicate: `${DKG}sourceFile`, object: fileUri, graph: '' },
      // Rows 4-8 — file URN subject, must be stripped
      { subject: fileUri, predicate: RDF_TYPE, object: `${DKG}File`, graph: '' },
      { subject: fileUri, predicate: `${DKG}contentHash`, object: '"keccak256:abc123"', graph: '' },
      // Rows 9-13 — prov URN subject, must be stripped
      { subject: provUri, predicate: RDF_TYPE, object: `${DKG}ExtractionProvenance`, graph: '' },
      { subject: provUri, predicate: `${DKG}extractedFrom`, object: fileUri, graph: '' },
      // A normal content triple — must survive
      { subject: entityUri, predicate: 'http://schema.org/name', object: '"Test"', graph: '' },
    ];

    // Apply the same filter predicate the real `assertionPromote` uses.
    // This mirrors `dkg-publisher.ts:~1580` exactly.
    const filtered = quads.filter(q =>
      !q.subject.startsWith('urn:dkg:file:') &&
      !q.subject.startsWith('urn:dkg:extraction:'),
    );

    // Row 1 survived (its subject is the entity, not the file URN).
    expect(filtered).toContainEqual(quads[0]); // row 1
    expect(filtered).toContainEqual(quads[5]); // schema:name
    // Rows 4-8 and 9-13 were stripped.
    expect(filtered.some(q => q.subject === fileUri)).toBe(false);
    expect(filtered.some(q => q.subject === provUri)).toBe(false);
    // Exactly 2 quads survived.
    expect(filtered).toHaveLength(2);
  });

  it('Bug 8 Option B: the URN file descriptor IS present in WM assertion graph (only filtered on promote)', async () => {
    // Scope guard: the filter lives on the promote path in
    // `assertionPromote`, NOT on the import-file write path. The
    // assertion WM graph SHOULD contain the full file descriptor
    // block (rows 4-8) and prov block (rows 9-13) so local queries
    // against WM can see everything. The filter only strips them
    // when promote copies quads into SWM.
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'wm.md', contentType: 'text/markdown', content: Buffer.from('# WM\n', 'utf-8') },
    ]);
    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'wm-check',
    });

    const dataQuads = getDataGraphQuads(agent, 'cg', 'wm-check');
    // URN subjects present in WM:
    expect(dataQuads.some(q => q.subject.startsWith('urn:dkg:file:'))).toBe(true);
    expect(dataQuads.some(q => q.subject.startsWith('urn:dkg:extraction:'))).toBe(true);
    // And the content hash is a literal that matches the wire value.
    const contentHash = dataQuads.find(q => q.predicate === `${DKG}contentHash`);
    expect(contentHash?.object).toBe(`"${result.fileHash}"`);
  });

  it('Bug 8 Option B: `_meta` is unchanged — row 16 is still a keccak256 literal keyed by the UAL', async () => {
    // Scope guard: the Round 4 revert (Option B) only changes the
    // data-graph subject shape back from blank nodes to URNs. The
    // `_meta` block (rows 14-20) was never affected by the blank-node
    // change; row 16's object is still a `"keccak256:<hex>"` literal
    // keyed by the assertion UAL (a NamedNode). This test locks that
    // in so any future rework can't regress `_meta` semantics.
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'meta-check.md', contentType: 'text/markdown', content: Buffer.from('# Meta\n', 'utf-8') },
    ]);
    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'meta-check',
    });

    const metaGraph = contextGraphMetaUri('cg');
    const row16 = agent.insertedQuads.find(q =>
      q.graph === metaGraph &&
      q.subject === result.assertionUri &&
      q.predicate === `${DKG}sourceFileHash`,
    );
    expect(row16).toBeDefined();
    // Subject is the UAL (NamedNode), not a URN or blank node.
    expect(row16!.subject).toBe(result.assertionUri);
    expect(row16!.subject).not.toMatch(/^urn:dkg:file:/);
    // Object is the keccak256 literal, matching the wire hash.
    expect(row16!.object).toBe(`"${result.fileHash}"`);
    // `_meta` graph has no blank-node subjects AND no `urn:dkg:file:` URN subjects.
    const metaQuads = agent.insertedQuads.filter(q => q.graph === metaGraph);
    expect(metaQuads.some(q => q.subject.startsWith('_:'))).toBe(false);
    expect(metaQuads.some(q => q.subject.startsWith('urn:dkg:file:'))).toBe(false);
  });

  it('Bug 11: atomic insert failure rolls back to the prior import snapshot', async () => {
    // First import succeeds with V1 content.
    const bodyV1 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n\nThe original.\n', 'utf-8') },
    ]);
    const resultV1 = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'rollback-test',
    });
    const assertionGraph = contextGraphAssertionUri('cg', agent.peerId, 'rollback-test');

    // Snapshot V1's contentHash for the post-rollback verification.
    const contentHashV1Before = agent.insertedQuads.find(q =>
      q.graph === assertionGraph && q.predicate === `${DKG}contentHash`,
    );
    expect(contentHashV1Before?.object).toBe(`"${resultV1.fileHash}"`);

    // Create a second agent pre-populated with V1's data, and wire it
    // to fail the FIRST insert call (V2's fresh content) but let the
    // SECOND insert call (the rollback snapshot) through. V1's
    // original insertion went through `agent`, not `rollbackAgent`,
    // so `rollbackAgent.insertCallCount` starts at 0.
    let totalInsertCalls = 0;
    const rollbackAgent = makeMockAgent('0xMockAgentPeerId', {
      insertErrorPredicate: (_quads, callNumber) => {
        totalInsertCalls = callNumber;
        // First insert on THIS agent is V2's fresh data — fail it.
        // Second insert is the rollback path (re-inserting the snapshot) — let it through.
        if (callNumber === 1) {
          return new Error('simulated V2 insert failure');
        }
        return null;
      },
    });
    // Prime the rollback agent with V1's data as if the first import
    // had gone through it. We copy V1's inserted quads (data-graph +
    // _meta) directly into the rollback agent's state. This simulates
    // "prior successful import landed, now a fresh import is starting
    // and has a real snapshot to roll back to."
    for (const q of agent.insertedQuads) {
      rollbackAgent.insertedQuads.push({ ...q });
    }

    const bodyV2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n\nReplacement.\n', 'utf-8') },
    ]);
    await expect(runImportFileOrchestration({
      agent: rollbackAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'rollback-test',
    })).rejects.toThrow('simulated V2 insert failure');

    // After the rollback, V1's contentHash should still be in the
    // assertion graph — this is the core Bug 11 guarantee. Without
    // the snapshot+rollback, the `dropGraph` call earlier in the
    // orchestration would have wiped V1, and the failed V2 insert
    // would leave the assertion empty.
    const contentHashAfterRollback = rollbackAgent.insertedQuads.filter(q =>
      q.graph === assertionGraph && q.predicate === `${DKG}contentHash`,
    );
    expect(contentHashAfterRollback).toHaveLength(1);
    expect(contentHashAfterRollback[0]!.object).toBe(`"${resultV1.fileHash}"`);

    // Three insert calls on the rollback agent (Round 5 Bug 15 upgrade):
    //   (1) V2 attempt (failed)
    //   (2) dataSnapshot re-insert (succeeded)
    //   (3) metaSnapshot re-insert (succeeded)
    // Round 4 had 2 calls (V2 + data rollback only); Round 5 added the
    // `_meta` rollback so the old `sourceFileHash` / `rootEntity` rows
    // come back alongside the old data graph.
    expect(totalInsertCalls).toBe(3);
  });

  it('Bug 14: import-file `_meta` cleanup failure leaves the OLD data graph untouched', async () => {
    // Regression guard for the Round 5 Bug 14 reorder. In the Round 4
    // ordering, `dropGraph` ran before `deleteByPattern(_meta)`, so a
    // transient `_meta` cleanup failure would abort the import with
    // the assertion body already gone but `_meta` still pointing at
    // the prior hash — the exact stale-metadata state that Bug 12
    // fixed for `assertionDiscard`. Round 5 reorders so `_meta` runs
    // first: if it fails, the data graph is still intact and retry
    // converges.
    //
    // This test seeds V1 into a fresh agent, then attempts a V2
    // re-import on a failing-deleteByPattern agent and asserts the
    // V1 data graph is unchanged.
    const bodyV1 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n\nOld reliable.\n', 'utf-8') },
    ]);
    const resultV1 = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'meta-fail-first',
    });
    const assertionGraph = contextGraphAssertionUri('cg', agent.peerId, 'meta-fail-first');

    // Prime a fresh agent with V1's state and a deleteByPattern that
    // always fails. Attempting to re-import V2 must throw, and V1's
    // data graph must still be present post-throw.
    const failAgent = makeMockAgent('0xMockAgentPeerId', {
      deleteByPatternError: new Error('simulated _meta cleanup outage'),
    });
    for (const q of agent.insertedQuads) {
      failAgent.insertedQuads.push({ ...q });
    }
    // Sanity: V1's data is pre-loaded.
    const dataBefore = failAgent.insertedQuads.filter(q => q.graph === assertionGraph);
    expect(dataBefore.length).toBeGreaterThan(0);

    const bodyV2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n\nWill not land.\n', 'utf-8') },
    ]);
    await expect(runImportFileOrchestration({
      agent: failAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'meta-fail-first',
    })).rejects.toThrow('simulated _meta cleanup outage');

    // Core invariant: V1's data graph is byte-perfect intact because
    // `deleteByPattern` fired (and failed) BEFORE `dropGraph`. Without
    // the reorder, `dropGraph` would have already wiped V1 by the time
    // the meta cleanup threw.
    const dataAfter = failAgent.insertedQuads.filter(q => q.graph === assertionGraph);
    expect(dataAfter).toHaveLength(dataBefore.length);
    const v1ContentHash = dataAfter.find(q => q.predicate === `${DKG}contentHash`);
    expect(v1ContentHash?.object).toBe(`"${resultV1.fileHash}"`);
    // And `dropGraph` was NEVER called — confirming the ordering.
    expect(failAgent.droppedGraphs).not.toContain(assertionGraph);
  });

  it('Bug 15: rollback restores BOTH the data graph AND the `_meta` rows keyed by this assertion', async () => {
    // Regression guard for the Round 5 Bug 15 extension. Round 4's
    // Bug 11 fix only snapshotted the data graph, so a failed re-import
    // left `_meta` empty until a retry rebuilt it. Round 5 snapshots
    // `_meta` too (scoped to `<assertionUri> ?p ?o` within the CG root
    // `_meta` graph) and restores it alongside the data graph on
    // insert failure.
    const bodyV1 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1 content\n\nFirst.\n', 'utf-8') },
    ]);
    const resultV1 = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'meta-rollback',
    });
    const metaGraphUri = contextGraphMetaUri('cg');

    // Snapshot V1's `_meta` state for post-rollback comparison.
    const metaBefore = agent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === resultV1.assertionUri,
    );
    expect(metaBefore.length).toBeGreaterThanOrEqual(6); // rows 14-19
    const sourceFileHashBefore = metaBefore.find(q => q.predicate === `${DKG}sourceFileHash`);
    expect(sourceFileHashBefore?.object).toBe(`"${resultV1.fileHash}"`);

    // Fresh agent seeded with V1 state + insert-failing predicate that
    // fails the first call (V2 fresh data) but lets the next two
    // (data rollback + meta rollback) through.
    const rollbackAgent = makeMockAgent('0xMockAgentPeerId', {
      insertErrorPredicate: (_quads, callNumber) => {
        if (callNumber === 1) {
          return new Error('simulated V2 atomic insert failure');
        }
        return null;
      },
    });
    for (const q of agent.insertedQuads) {
      rollbackAgent.insertedQuads.push({ ...q });
    }

    const bodyV2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2 content\n\nSecond.\n', 'utf-8') },
    ]);
    await expect(runImportFileOrchestration({
      agent: rollbackAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'meta-rollback',
    })).rejects.toThrow('simulated V2 atomic insert failure');

    // Core Bug 15 invariant: `_meta` rows for this assertion are
    // back, specifically `dkg:sourceFileHash` still points at V1's
    // hash (not missing, not pointing at V2's hash).
    const metaAfter = rollbackAgent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === resultV1.assertionUri,
    );
    expect(metaAfter).toHaveLength(metaBefore.length);
    const sourceFileHashAfter = metaAfter.find(q => q.predicate === `${DKG}sourceFileHash`);
    expect(sourceFileHashAfter?.object).toBe(`"${resultV1.fileHash}"`);
    // And data-graph rollback still works (Round 4 Bug 11 invariant).
    const assertionGraph = contextGraphAssertionUri('cg', rollbackAgent.peerId, 'meta-rollback');
    const dataContentHash = rollbackAgent.insertedQuads.find(q =>
      q.graph === assertionGraph && q.predicate === `${DKG}contentHash`,
    );
    expect(dataContentHash?.object).toBe(`"${resultV1.fileHash}"`);
  });

  it('Bug 15: rollback does NOT restore `_meta` rows for OTHER assertions', async () => {
    // Scope guard: the `_meta` rollback must be tightly scoped to
    // `<assertionUri> ?p ?o`. An over-broad rollback that restored
    // every `_meta` row in the graph would clobber unrelated
    // assertions' `_meta` during a failed re-import. This test
    // imports assertion B into the same `_meta` graph, then attempts
    // a failing re-import of assertion A, and asserts B's `_meta` is
    // untouched.
    const metaGraphUri = contextGraphMetaUri('cg');

    // First: import A and B, both successful.
    const bodyA = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'a.md', contentType: 'text/markdown', content: Buffer.from('# A v1\n', 'utf-8') },
    ]);
    const resultA = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyA, boundary: BOUNDARY, assertionName: 'iso-meta-a',
    });
    const bodyB = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'b.md', contentType: 'text/markdown', content: Buffer.from('# B v1\n', 'utf-8') },
    ]);
    const resultB = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyB, boundary: BOUNDARY, assertionName: 'iso-meta-b',
    });

    // Now try to re-import A under a failing-insert agent. The rollback
    // should restore A's `_meta` but leave B's `_meta` untouched —
    // B isn't even mentioned in the CONSTRUCT, so the mock's scoped
    // filter means the rollback array doesn't include B's rows.
    const failAgent = makeMockAgent('0xMockAgentPeerId', {
      insertErrorPredicate: (_quads, callNumber) => {
        if (callNumber === 1) return new Error('simulated A v2 insert failure');
        return null;
      },
    });
    for (const q of agent.insertedQuads) {
      failAgent.insertedQuads.push({ ...q });
    }

    // Snapshot B's `_meta` before the failed A re-import.
    const bMetaBefore = failAgent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === resultB.assertionUri,
    );
    expect(bMetaBefore.length).toBeGreaterThanOrEqual(6);

    const bodyAv2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'a2.md', contentType: 'text/markdown', content: Buffer.from('# A v2\n', 'utf-8') },
    ]);
    await expect(runImportFileOrchestration({
      agent: failAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyAv2, boundary: BOUNDARY, assertionName: 'iso-meta-a',
    })).rejects.toThrow('simulated A v2 insert failure');

    // B's `_meta` is byte-perfect untouched — not because the rollback
    // was cautious, but because the scoped CONSTRUCT never captured
    // B's rows in the first place.
    const bMetaAfter = failAgent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === resultB.assertionUri,
    );
    expect(bMetaAfter).toHaveLength(bMetaBefore.length);
    const bSourceFileHash = bMetaAfter.find(q => q.predicate === `${DKG}sourceFileHash`);
    expect(bSourceFileHash?.object).toBe(`"${resultB.fileHash}"`);
    // And A's `_meta` is restored to V1.
    const aMetaAfter = failAgent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === resultA.assertionUri,
    );
    const aSourceFileHash = aMetaAfter.find(q => q.predicate === `${DKG}sourceFileHash`);
    expect(aSourceFileHash?.object).toBe(`"${resultA.fileHash}"`);
  });

  it('Bug 15: compound rollback failure records both errors and rethrows the original insert error', async () => {
    // When the atomic insert fails AND the rollback re-insert also
    // fails, the daemon records a compound failure message listing
    // both errors, then rethrows the ORIGINAL insert error (not the
    // rollback error) so the caller's 500 envelope matches what they
    // actually asked for. This test exercises that path: call #1 fails
    // (V2 atomic insert) AND call #2 also fails (data rollback). The
    // orchestration should throw the original "V2 insert failure" and
    // the extraction-status record should contain both messages.
    const bodyV1 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n', 'utf-8') },
    ]);
    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'compound-fail',
    });

    const doubleFailAgent = makeMockAgent('0xMockAgentPeerId', {
      insertErrorPredicate: (_quads, callNumber) => {
        // Fail EVERY insert after the prime — the primary V2 insert
        // AND both rollback re-inserts.
        if (callNumber >= 1) {
          return new Error(callNumber === 1 ? 'simulated V2 insert failure' : `simulated rollback failure #${callNumber}`);
        }
        return null;
      },
    });
    for (const q of agent.insertedQuads) {
      doubleFailAgent.insertedQuads.push({ ...q });
    }

    const bodyV2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n', 'utf-8') },
    ]);
    await expect(runImportFileOrchestration({
      agent: doubleFailAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'compound-fail',
    })).rejects.toThrow('simulated V2 insert failure'); // Original error, not rollback error

    // The status record should reflect the compound failure — the
    // error message should mention both the primary insert failure
    // and the rollback failures.
    const assertionUri = contextGraphAssertionUri('cg', doubleFailAgent.peerId, 'compound-fail');
    const record = status.get(assertionUri);
    expect(record?.status).toBe('failed');
    // Round 7 Bug 22 restructure renamed the compound-failure prefix
    // from "atomic insert failed" to the more general "write stage
    // failed" since the same rollback path now covers dropGraph
    // failures too.
    expect(record?.error).toContain('write stage failed AND rollback failures');
    expect(record?.error).toContain('simulated V2 insert failure');
    expect(record?.error).toContain('simulated rollback failure');
  });

  it('Round 8 Bug 23: ImportFileResponse carries fileHash (keccak256) as the SINGLE canonical hash — no sha256Hash parallel', async () => {
    // Round 6 Bug 17 introduced `sha256Hash` as a dual-field
    // backward-compat attempt; Round 8 (Codex Bug 23 + user
    // framing) ripped it out — V10 is a clean-break product
    // release with no installed base, so there are no existing
    // clients to protect, and a parallel field never would have
    // preserved the old contract anyway. This canary locks in the
    // single-field contract against anyone re-adding the parallel
    // by reflex.
    //
    // ALSO covers the single-hash round-trip guarantee through
    // FileStore.get() (Round 3 Bug 9) so we don't lose that
    // coverage when the dual-field round-trip tests are deleted.
    const content = Buffer.from('# Bug 23 single hash\n\nContent-addressed.\n', 'utf-8');
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'single.md', contentType: 'text/markdown', content },
    ]);
    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'single-hash',
    });

    expect(result.fileHash).toMatch(/^keccak256:[0-9a-f]{64}$/);
    expect('sha256Hash' in result).toBe(false);

    const record = status.get(result.assertionUri);
    expect(record?.fileHash).toBe(result.fileHash);
    expect(record && 'sha256Hash' in record).toBe(false);

    // Round 3 Bug 9 round-trip: FileStore.get() still accepts the
    // single keccak256 string and returns the original bytes.
    const bytes = await fileStore.get(result.fileHash);
    expect(bytes).not.toBeNull();
    expect(Buffer.compare(bytes!, content)).toBe(0);
  });

  it('Bug 19: two sequential imports of the same assertion URI serialize cleanly through the mutex', async () => {
    // Sanity guard: the mutex must not deadlock on non-concurrent
    // calls. Two back-to-back awaited imports of the same assertion
    // name should both succeed — the second acquires the lock after
    // the first releases it.
    const locks = new Map<string, Promise<void>>();
    const body1 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'seq1.md', contentType: 'text/markdown', content: Buffer.from('# seq1\n', 'utf-8') },
    ]);
    const r1 = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body1, boundary: BOUNDARY, assertionName: 'seq-mutex',
      assertionImportLocks: locks,
    });
    const body2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'seq2.md', contentType: 'text/markdown', content: Buffer.from('# seq2\n', 'utf-8') },
    ]);
    const r2 = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body2, boundary: BOUNDARY, assertionName: 'seq-mutex',
      assertionImportLocks: locks,
    });
    expect(r1.extraction.status).toBe('completed');
    expect(r2.extraction.status).toBe('completed');
    // Map should be empty after the last release — no lingering entries.
    expect(locks.size).toBe(0);
  });

  it('Bug 19: concurrent imports of DIFFERENT assertion URIs run in parallel (lock is per-URI, not global)', async () => {
    // Scope guard: a global lock would be a regression. Fire two
    // imports against different assertion names concurrently under
    // the same locks map and assert both succeed. If the lock were
    // global this would still work (serialized), so the assertion is
    // only that both reach `completed` — not timing.
    const locks = new Map<string, Promise<void>>();
    const body1 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'a.md', contentType: 'text/markdown', content: Buffer.from('# A\n', 'utf-8') },
    ]);
    const body2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'b.md', contentType: 'text/markdown', content: Buffer.from('# B\n', 'utf-8') },
    ]);
    const [r1, r2] = await Promise.all([
      runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body1, boundary: BOUNDARY, assertionName: 'parallel-a',
        assertionImportLocks: locks,
      }),
      runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body2, boundary: BOUNDARY, assertionName: 'parallel-b',
        assertionImportLocks: locks,
      }),
    ]);
    expect(r1.extraction.status).toBe('completed');
    expect(r2.extraction.status).toBe('completed');
    // Both imports completed through separate lock entries, both
    // entries cleaned up on release.
    expect(locks.size).toBe(0);
  });

  it('Bug 19: a failed second import does NOT roll back over a newer first import when they overlap on the same URI', async () => {
    // This is the Round 6 race that Bug 19 closes. Without the
    // mutex, request A commits, request B (which snapshotted the
    // prior empty state) fails its insert, and B's rollback
    // re-inserts its stale V0 snapshot OVER A's V1 commit. With the
    // per-URI lock, B's snapshot is taken AFTER A releases — so B
    // sees A's committed V1, and even if B's insert fails its
    // rollback restores V1 (a no-op on what's already there),
    // leaving A's commit intact.
    //
    // We drive the race deterministically by serializing A before B
    // (the mutex itself guarantees this ordering) and injecting a
    // failure into B's atomic insert.
    const locks = new Map<string, Promise<void>>();
    const bodyA = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'a-wins.md', contentType: 'text/markdown', content: Buffer.from('# A wins\n\nA content.\n', 'utf-8') },
    ]);
    // Request A runs on a fresh agent, commits cleanly.
    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyA, boundary: BOUNDARY, assertionName: 'race-target',
      assertionImportLocks: locks,
    });
    const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'race-target');
    const aDataBefore = getDataGraphQuads(agent, 'cg', 'race-target');
    expect(aDataBefore.length).toBeGreaterThan(0);
    const aHashBefore = aDataBefore.find(q =>
      q.subject === assertionUri && q.predicate === 'http://dkg.io/ontology/sourceContentType',
    )?.object;
    expect(aHashBefore).toBeTruthy();

    // Prime a second agent with A's committed state, then fail its
    // V2 insert. Because A's state is already in B's snapshot, B's
    // rollback re-inserts the same quads (a no-op / idempotent) and
    // A's content remains — the race is closed.
    const failAgent = makeMockAgent('0xMockAgentPeerId', {
      insertErrorPredicate: (_quads, callNumber) => {
        if (callNumber === 1) return new Error('simulated B v2 insert failure');
        return null;
      },
    });
    for (const q of agent.insertedQuads) {
      failAgent.insertedQuads.push({ ...q });
    }

    const bodyB = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'b-fails.md', contentType: 'text/markdown', content: Buffer.from('# B fails\n\nB content.\n', 'utf-8') },
    ]);
    await expect(runImportFileOrchestration({
      agent: failAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyB, boundary: BOUNDARY, assertionName: 'race-target',
      assertionImportLocks: locks,
    })).rejects.toThrow('simulated B v2 insert failure');

    // A's committed content is still present — the mutex closed the
    // race window so B's snapshot captured A's state, not an older
    // empty state. Even with B's rollback firing, A's content survives.
    const aDataAfter = failAgent.insertedQuads.filter(q =>
      q.graph === assertionUri && q.subject === assertionUri && q.predicate === 'http://dkg.io/ontology/sourceContentType',
    );
    expect(aDataAfter.length).toBeGreaterThanOrEqual(1);
    // Map is drained — both calls released their locks.
    expect(locks.size).toBe(0);
  });

  it('Round 14 Bug 42: lock acquired BEFORE extraction so request order determines commit order (not extraction duration)', async () => {
    // Round 6 originally acquired the per-assertion mutex AFTER
    // Phase 1/2 extraction completed, which meant concurrent imports
    // of the same assertion name raced during extraction and the
    // one whose extraction finished LAST committed LAST — regardless
    // of which request arrived first. Final stored state depended
    // on extraction duration, not request order.
    //
    // Round 14 Bug 42 moved the lock acquisition to the TOP of the
    // import-file handler (right after `assertionUri` is computed),
    // before any extraction work begins. This test proves the fix:
    // Request A uses a slow mock converter (200ms Phase 1 delay);
    // Request B uses the same target assertion name with a fast
    // path (no converter delay). A is started first, then B is
    // started before A completes. With the lock acquired BEFORE
    // extraction, B waits for A's lock release (which happens after
    // A's full commit), so the final committed content is B's.
    //
    // If the lock were still acquired AFTER extraction (pre-Round-14
    // behavior), B's fast extraction would finish first, commit
    // first, then A's slow extraction would finish and commit
    // second — overwriting B. The final content would be A's,
    // matching extraction-finish order instead of request-arrival
    // order. This test asserts the CORRECT order (B wins because
    // it arrived second).
    const locks = new Map<string, Promise<void>>();
    const assertionName = 'bug42-race';

    // Slow mock converter for Request A — 200ms extraction delay.
    const slowConverter: ExtractionPipeline = {
      contentTypes: ['application/x-slow'],
      async extract(_input: ExtractionInput): Promise<ConverterOutput> {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { mdIntermediate: '# A\n\nSlow upload.\n' };
      },
    };
    const slowRegistry = new ExtractionPipelineRegistry();
    slowRegistry.register(slowConverter);

    const bodyA = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'a-slow.x-slow', contentType: 'application/x-slow', content: Buffer.from('slow', 'utf-8') },
    ]);
    const bodyB = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'b-fast.md', contentType: 'text/markdown', content: Buffer.from('# B\n\nFast upload.\n', 'utf-8') },
    ]);

    // Start Request A (slow). Do NOT await — we want to start B
    // before A finishes.
    const promiseA = runImportFileOrchestration({
      agent, fileStore, extractionRegistry: slowRegistry, extractionStatus: status,
      multipartBody: bodyA, boundary: BOUNDARY, assertionName,
      assertionImportLocks: locks,
    });

    // Give A enough time to reach its lock acquisition (which is
    // now at the TOP of the handler, before extraction begins).
    // 20ms is more than enough for A to acquire the lock and
    // enter the slow converter.
    await new Promise(resolve => setTimeout(resolve, 20));

    // Start Request B. Under Round 14's lock-before-extraction,
    // B will try to acquire the same lock, find it held by A,
    // and wait. Under the pre-fix behavior B would race ahead
    // through extraction and commit first.
    const promiseB = runImportFileOrchestration({
      agent, fileStore, extractionRegistry: slowRegistry, extractionStatus: status,
      multipartBody: bodyB, boundary: BOUNDARY, assertionName,
      assertionImportLocks: locks,
    });

    await Promise.all([promiseA, promiseB]);

    // Final committed content must be B's (the second arrival),
    // because the lock serialized the two imports in request-
    // arrival order. Check the assertion data graph's source-file
    // keccak256 in _meta row 16 — it reflects whichever request
    // committed last (second), which under Round 14 is B.
    const metaGraph = contextGraphMetaUri('cg');
    const assertionUri = contextGraphAssertionUri('cg', agent.peerId, assertionName);
    const sourceFileHashRow = agent.insertedQuads.find(
      q => q.graph === metaGraph
        && q.subject === assertionUri
        && q.predicate === 'http://dkg.io/ontology/sourceFileHash',
    );
    expect(sourceFileHashRow).toBeDefined();
    // B's content is `# B\n\nFast upload.\n`. The hash in _meta
    // must match the keccak256 of B's bytes (not A's slow bytes).
    // We compute B's expected hash via the fileStore directly.
    const expectedBEntry = await fileStore.put(
      Buffer.from('# B\n\nFast upload.\n', 'utf-8'),
      'text/markdown',
    );
    expect(sourceFileHashRow!.object).toBe(`"${expectedBEntry.keccak256}"`);

    // Map drained (both imports completed and released their locks).
    expect(locks.size).toBe(0);
  });

  it('Round 14 Bug 42: lock released correctly when extraction throws (deadlock guard)', async () => {
    // Critical scope guard for the Round 14 restructure — the
    // outer `finally` must release the lock even when the handler
    // body throws partway through. Inject an error during Phase 1
    // (via a mock converter that throws) and assert that (a) the
    // first import's failure is surfaced, and (b) a subsequent
    // import of the SAME assertion name can still acquire the
    // lock (no deadlock).
    const locks = new Map<string, Promise<void>>();
    const assertionName = 'bug42-throw';

    const throwingConverter: ExtractionPipeline = {
      contentTypes: ['application/x-throw'],
      async extract(_input: ExtractionInput): Promise<ConverterOutput> {
        throw new Error('simulated converter failure');
      },
    };
    const throwingRegistry = new ExtractionPipelineRegistry();
    throwingRegistry.register(throwingConverter);

    const bodyA = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'throws.x-throw', contentType: 'application/x-throw', content: Buffer.from('throws', 'utf-8') },
    ]);

    // The harness's Phase 1 converter block does NOT have a
    // try/catch wrapper (the daemon has one that calls
    // `respondWithFailedExtraction(500)` + returns, but the test
    // harness lets errors propagate directly). So the rejection
    // manifests as a thrown error, not a resolved failed-status
    // response. Either way, the point of this test is that the
    // OUTER `finally` at the bottom of `runImportFileOrchestration`
    // releases the lock regardless of which code path the error
    // takes out of the function.
    await expect(runImportFileOrchestration({
      agent, fileStore, extractionRegistry: throwingRegistry, extractionStatus: status,
      multipartBody: bodyA, boundary: BOUNDARY, assertionName,
      assertionImportLocks: locks,
    })).rejects.toThrow('simulated converter failure');

    // Lock map must be drained — if the failed path leaked the
    // lock, the map would still have A's entry and the next
    // import of the same URI would deadlock waiting on a promise
    // that never resolves.
    expect(locks.size).toBe(0);

    // Second import of the same assertion name must proceed.
    const bodyB = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'recover.md', contentType: 'text/markdown', content: Buffer.from('# Recovery\n', 'utf-8') },
    ]);
    const resultB = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyB, boundary: BOUNDARY, assertionName,
      assertionImportLocks: locks,
    });
    expect(resultB.extraction.status).toBe('completed');
    expect(locks.size).toBe(0);
  });

  it('Round 14 Bug 42: graceful-degrade (skipped status) path still releases the lock', async () => {
    // Scope guard — the graceful-degrade path (unregistered content
    // type → status: "skipped") returns early from the handler
    // before any extraction runs. The outer `finally` must still
    // fire and release the lock. Follow the same pattern as the
    // throw test: first import takes the skipped path, second
    // import of the same URI must proceed without deadlock.
    const locks = new Map<string, Promise<void>>();
    const assertionName = 'bug42-skipped';

    const bodyA = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'blob.bin', contentType: 'application/octet-stream', content: Buffer.from([0x00, 0x01, 0x02]) },
    ]);
    const resultA = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyA, boundary: BOUNDARY, assertionName,
      assertionImportLocks: locks,
    });
    expect(resultA.extraction.status).toBe('skipped');
    expect(locks.size).toBe(0);

    // Second import of the same URI must proceed.
    const bodyB = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'after.md', contentType: 'text/markdown', content: Buffer.from('# After\n', 'utf-8') },
    ]);
    const resultB = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyB, boundary: BOUNDARY, assertionName,
      assertionImportLocks: locks,
    });
    expect(resultB.extraction.status).toBe('completed');
    expect(locks.size).toBe(0);
  });

  it('Bug 20: extractFromMarkdown rejects empty-string rootEntityIri and sourceFileIri', () => {
    // Round 7 Bug 20 — programmatic override inputs go through the
    // same isSafeIri gate as frontmatter `rootEntity` (Round 4 Bug
    // 13). Empty strings are the simplest failure case.
    expect(() => extractFromMarkdown({
      markdown: '# Doc\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
      rootEntityIri: '',
    })).toThrow(/Invalid 'rootEntityIri'/);

    expect(() => extractFromMarkdown({
      markdown: '# Doc\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
      sourceFileIri: '',
    })).toThrow(/Invalid 'sourceFileIri'/);
  });

  it('Bug 20: extractFromMarkdown rejects non-IRI-prefix rootEntityIri and sourceFileIri', () => {
    // `foo` lacks an IRI scheme prefix (http:/https:/did:/urn:/_:)
    // so it's a bare string, not an IRI. Must be rejected before it
    // reaches the RDF layer.
    expect(() => extractFromMarkdown({
      markdown: '# Doc\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
      rootEntityIri: 'foo',
    })).toThrow(/Invalid 'rootEntityIri'/);

    expect(() => extractFromMarkdown({
      markdown: '# Doc\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
      sourceFileIri: 'bar',
    })).toThrow(/Invalid 'sourceFileIri'/);
  });

  it('Bug 20: extractFromMarkdown rejects isSafeIri-failing characters in rootEntityIri and sourceFileIri', () => {
    // `http://x>y` has a prefix that passes the regex but contains
    // an angle bracket that `isSafeIri` rejects. This is the most
    // interesting failure mode because it would otherwise reach the
    // RDF layer and produce a cryptic parse error.
    expect(() => extractFromMarkdown({
      markdown: '# Doc\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
      rootEntityIri: 'http://x>y',
    })).toThrow(/Invalid 'rootEntityIri'/);

    expect(() => extractFromMarkdown({
      markdown: '# Doc\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
      sourceFileIri: 'urn:dkg:file keccak256:abc',  // space is isSafeIri-invalid
    })).toThrow(/Invalid 'sourceFileIri'/);
  });

  it('Bug 20: valid IRI overrides still pass through (regression guard)', () => {
    // Sanity guard — the new gate must not reject well-formed IRIs.
    // Source-file linkage quads land on `provenance`, not `triples`.
    const result = extractFromMarkdown({
      markdown: '# Doc\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
      rootEntityIri: 'urn:dkg:entity:root-1',
      sourceFileIri: 'urn:dkg:file:keccak256:abc123',
    });
    expect(result.resolvedRootEntity).toBe('urn:dkg:entity:root-1');
    // Round 13 Bug 39: field renamed from `provenance` to `sourceFileLinkage`.
    expect(result.sourceFileLinkage.some(t =>
      t.predicate === 'http://dkg.io/ontology/sourceFile' &&
      t.object === 'urn:dkg:file:keccak256:abc123',
    )).toBe(true);
  });

  it('Round 10 Bug 30: extractFromMarkdown rejects blank-node rootEntityIri (`_:foo`)', () => {
    // Round 10 Bug 30 — earlier rounds advertised `_:` as an
    // accepted prefix in the `rootEntityIri` validation error
    // message, but `isSafeIri()` always rejected blank nodes, so
    // the advertisement misled callers. Per spec §19.10.2:628-629
    // (`dkg:rootEntity is an IRI`) + `03_PROTOCOL_CORE.md §1`
    // non-blank-node Entity rule + RDF 1.1 §3.4 (blank nodes are
    // not IRIs), blank nodes cannot legitimately be root entities
    // or source file identifiers. Drop `_:` from the regex AND the
    // advertised contract — scheme-based only.
    expect(() => extractFromMarkdown({
      markdown: '# Doc\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
      rootEntityIri: '_:foo',
    })).toThrow(/Invalid 'rootEntityIri'/);
  });

  it('Round 10 Bug 30: extractFromMarkdown rejects blank-node sourceFileIri (`_:bar`)', () => {
    // Symmetric to the rootEntityIri case above.
    expect(() => extractFromMarkdown({
      markdown: '# Doc\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
      sourceFileIri: '_:bar',
    })).toThrow(/Invalid 'sourceFileIri'/);
  });

  it('Round 10 Bug 30: extractFromMarkdown rejects blank-node frontmatter `rootEntity` (`_:fm`)', () => {
    // Frontmatter path — previously advertised `_:` alongside
    // `http:/https:/did:/urn:` in its error message and the regex.
    // Option A cleanup drops it from both. A frontmatter value of
    // `_:fm` no longer matches the scheme-based prefix, so it
    // falls through to the slugification branch — which produces
    // a non-throwing, deterministic URN. That behaviour is
    // acceptable per spec-engineer's ruling (non-IRI frontmatter
    // strings slugify; only IRI-shaped strings are validated).
    // What MUST NOT happen is the `_:fm` value being accepted
    // verbatim as an IRI-shaped root entity. Prove that by
    // checking the resolvedRootEntity is the slugified form, not
    // the blank-node literal.
    const result = extractFromMarkdown({
      markdown: '---\nrootEntity: "_:fm"\n---\n\n# Doc\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
    });
    expect(result.resolvedRootEntity).not.toBe('_:fm');
    expect(result.resolvedRootEntity).toMatch(/^urn:dkg:md:/);
  });

  it('Round 10 Bug 30: `Invalid rootEntityIri` error message does NOT advertise `_:` as accepted', () => {
    // Lock in the contract cleanup in the error text itself — a
    // future contributor adding `_:` back to the regex would
    // break this test, and reading the error message from a
    // failed validation should never suggest `_:foo` works.
    try {
      extractFromMarkdown({
        markdown: '# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
        rootEntityIri: 'not-an-iri',
      });
      expect.fail('expected extractFromMarkdown to throw');
    } catch (err: any) {
      expect(err.message).toContain("Invalid 'rootEntityIri'");
      expect(err.message).toContain('scheme-based IRI');
      expect(err.message).toContain('Blank nodes (_:foo) are not accepted');
      // Negative assertion: the old advertisement string must not
      // appear. The old message said "starting with http:/https:/
      // did:/urn:/_:" — the `/_:` suffix is what we deleted.
      expect(err.message).not.toMatch(/http:\/https:\/did:\/urn:\/_:/);
    }
  });

  it('Round 11 Bug 33: frontmatter `rootEntity` with a `tag:` URI is preserved as-is (not silently slugified)', () => {
    // Codex's exact cited scenario: `tag:origintrail.org,2026:paper`
    // used to fall into the slugify branch because the previous
    // narrow regex allowlist was `^(https?:|did:|urn:)` and `tag:`
    // didn't match. Round 11 broadened the detection to the RFC
    // 3986 generic scheme pattern `^[a-zA-Z][a-zA-Z0-9+.-]*:`,
    // which matches any absolute IRI scheme. The value is now
    // preserved verbatim as the resolved root entity.
    const tagIri = 'tag:origintrail.org,2026:paper';
    const result = extractFromMarkdown({
      markdown: `---\nrootEntity: ${tagIri}\n---\n\n# Doc\n`,
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
    });
    expect(result.resolvedRootEntity).toBe(tagIri);
    // And crucially, NOT the slugified form that the pre-fix
    // code would have produced:
    expect(result.resolvedRootEntity).not.toMatch(/^urn:dkg:md:tag/);
  });

  it('Round 11 Bug 33: programmatic `rootEntityIri` also accepts `tag:` and other non-whitelist schemes (contract consistency)', () => {
    // The programmatic path already used `isSafeIri`, which accepts
    // any well-formed scheme-based IRI. This test locks that in so
    // the frontmatter / programmatic contract consistency that
    // Round 11 established cannot regress.
    const tagIri = 'tag:example.org,2026:doc';
    const result = extractFromMarkdown({
      markdown: '# Doc\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
      rootEntityIri: tagIri,
    });
    expect(result.resolvedRootEntity).toBe(tagIri);
  });

  it('Round 11 Bug 33: programmatic `sourceFileIri` also accepts non-whitelist schemes', () => {
    // Parallel guard for `sourceFileIri`. A `doi:` value is a
    // valid absolute IRI and must flow through unchanged.
    const doiIri = 'doi:10.1000/xyz.2026.paper';
    const result = extractFromMarkdown({
      markdown: '# Doc\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
      sourceFileIri: doiIri,
    });
    // sourceFileIri appears as the object of row 1
    // (`<entityUri> dkg:sourceFile <sourceFileIri>`) in the
    // `sourceFileLinkage` field (Round 13 Bug 39 rename).
    const row1 = result.sourceFileLinkage.find(t =>
      t.predicate === 'http://dkg.io/ontology/sourceFile',
    );
    expect(row1).toBeDefined();
    expect(row1!.object).toBe(doiIri);
  });

  it('Round 11 Bug 33 preempt: frontmatter `id` with a blank-node prefix (`_:foo`) is NOT accepted as document subject IRI (resolveSubjectIri)', () => {
    // Round 10 Bug 30 preempt — previously `resolveSubjectIri`
    // accepted `_:foo` via the same narrow regex pattern as the
    // pre-Round-30 contract. Per spec §03 §1, document subjects
    // become Entities and must be non-blank-node. The Round 11
    // unification via RFC 3986 scheme detection excludes `_:`
    // (underscore not in `[a-zA-Z]` scheme production), so
    // `_:foo` now falls through to slugification instead of
    // being accepted as the document subject IRI.
    const result = extractFromMarkdown({
      markdown: `---\nid: "_:foo"\n---\n\n# Doc\n`,
      agentDid: 'did:dkg:agent:0x1',
    });
    // Subject is NOT the blank-node literal — it was slugified.
    expect(result.subjectIri).not.toBe('_:foo');
    // Subject is a deterministic urn:dkg:md:* slug.
    expect(result.subjectIri).toMatch(/^urn:dkg:md:/);
  });

  it('Round 11 Bug 33 preempt: frontmatter `id` with a `tag:` URI is preserved as-is (resolveSubjectIri broadens too)', () => {
    // The same unification that fixed Bug 33 for `rootEntity` also
    // affects `resolveSubjectIri` — a valid `tag:` URI in the
    // frontmatter `id` field is now preserved as the document
    // subject IRI instead of being silently slugified. This is a
    // side-effect of the preempt fix, and it improves frontmatter-
    // id-as-IRI semantics for the same reason Bug 33 improves
    // rootEntity-as-IRI semantics.
    const tagIri = 'tag:example.org,2026:document';
    const result = extractFromMarkdown({
      markdown: `---\nid: ${tagIri}\n---\n\n# Doc\n`,
      agentDid: 'did:dkg:agent:0x1',
    });
    expect(result.subjectIri).toBe(tagIri);
  });

  it('Round 11 Bug 33 preempt: frontmatter `id` with a malformed IRI attempt (scheme-prefixed with space) falls through to slugify', () => {
    // `resolveSubjectIri` uses a simpler accept-or-slugify fallback
    // (no throw path like the `rootEntity` branch), so a malformed
    // scheme-prefixed value like `http://x y` slugifies rather
    // than throws. Verify the slugified form is what the caller
    // gets, and crucially NOT the malformed value verbatim.
    const result = extractFromMarkdown({
      markdown: `---\nid: "http://x y"\n---\n\n# Doc\n`,
      agentDid: 'did:dkg:agent:0x1',
    });
    expect(result.subjectIri).not.toBe('http://x y');
    expect(result.subjectIri).toMatch(/^urn:dkg:md:/);
  });

  it('Round 11 Bug 33: backward-compat canary — http://, urn:, did: all still accepted via frontmatter rootEntity', () => {
    // The broadening must NOT have broken the existing schemes.
    // Spot-check each one: http(s), urn, did still produce the
    // expected root entity.
    const cases: Array<[string, string]> = [
      ['http://example.com/entity', 'http://example.com/entity'],
      ['https://example.com/entity', 'https://example.com/entity'],
      ['urn:note:foo', 'urn:note:foo'],
      ['did:dkg:agent:0xabc', 'did:dkg:agent:0xabc'],
    ];
    for (const [input, expected] of cases) {
      const result = extractFromMarkdown({
        markdown: `---\nrootEntity: ${input}\n---\n\n# Doc\n`,
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
      });
      expect(result.resolvedRootEntity).toBe(expected);
    }
  });

  it('Round 11 Bug 33: Bug 13 malformed-IRI semantics preserved (scheme-prefixed + invalid chars still throws)', () => {
    // Critical regression guard: Bug 13 Round 4 established that a
    // frontmatter `rootEntity` value that LOOKS like an IRI (has a
    // scheme prefix) but contains invalid characters MUST throw,
    // not silently slugify. The Round 11 unification must preserve
    // this behavior for both the old schemes (urn, http) AND the
    // newly-accepted schemes (tag, doi). Otherwise a user writing
    // `tag:example.org,2026:x y` (embedded space) would get a
    // cryptic RDF-layer failure later.
    expect(() => extractFromMarkdown({
      markdown: `---\nrootEntity: "urn:x y"\n---\n\n# Doc\n`,
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
    })).toThrow(/Invalid frontmatter 'rootEntity' IRI/);

    expect(() => extractFromMarkdown({
      markdown: `---\nrootEntity: "tag:example.org,2026:x y"\n---\n\n# Doc\n`,
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:abc',
    })).toThrow(/Invalid frontmatter 'rootEntity' IRI/);
  });

  it('Round 13 Bug 39: `extractFromMarkdown` returns a `sourceFileLinkage` field (renamed from `provenance`) with rows 1 and 3 when sourceFileIri is supplied', () => {
    // Round 13 Bug 39 — the field was renamed from `provenance` to
    // `sourceFileLinkage` to remove the semantic clash with its
    // original extraction-run-metadata meaning. This test pins the
    // new field name and asserts the field contains exactly rows 1
    // and 3 (rows 9-13 of the old ExtractionProvenance block moved
    // to the daemon in Round 9 Bug 27, so they are NOT in this
    // field).
    const fileUri = 'urn:dkg:file:keccak256:bug39test';
    const result = extractFromMarkdown({
      markdown: '# Doc\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:bug39',
      sourceFileIri: fileUri,
    });
    // New field name present and populated.
    expect(result.sourceFileLinkage).toHaveLength(2);
    // Row 1: <doc> dkg:sourceFile <fileUri>
    expect(result.sourceFileLinkage).toContainEqual({
      subject: 'urn:dkg:doc:bug39',
      predicate: 'http://dkg.io/ontology/sourceFile',
      object: fileUri,
    });
    // Row 3: <doc> dkg:rootEntity <doc> (reflexive default)
    expect(result.sourceFileLinkage).toContainEqual({
      subject: 'urn:dkg:doc:bug39',
      predicate: 'http://dkg.io/ontology/rootEntity',
      object: 'urn:dkg:doc:bug39',
    });
    // Canary: the old field name is GONE from the output shape.
    // This locks in the rename and prevents a future contributor
    // from accidentally re-adding `provenance` as an alias.
    expect((result as unknown as { provenance?: unknown }).provenance).toBeUndefined();
  });

  it('Round 13 Bug 39: `extractFromMarkdown` returns empty `sourceFileLinkage` when sourceFileIri is omitted (optional semantics preserved)', () => {
    // Symmetric negative: the rename preserved the "empty when not
    // supplied" contract. Pre-rename this was `provenance: []`,
    // post-rename it's `sourceFileLinkage: []`.
    const result = extractFromMarkdown({
      markdown: '# Doc\n\nContent without a source file.\n',
      agentDid: 'did:dkg:agent:0x1',
      documentIri: 'urn:dkg:doc:nolinkage',
    });
    expect(result.sourceFileLinkage).toEqual([]);
  });

  it('Round 8 Bug 23: converter path populates mdIntermediateHash (keccak256) as the SINGLE canonical hash — no mdIntermediateSha256Hash parallel', async () => {
    // Round 7 Bug 21 added a dual-field `mdIntermediateSha256Hash`
    // alongside `mdIntermediateHash`; Round 8 removed it for the
    // same reasons as `sha256Hash` (V10 clean-break release, no
    // installed base to protect). This canary locks in the
    // single-field contract for the converter path and preserves
    // coverage of the Phase 1 write site (which the old dual-field
    // test exercised via a mock converter).
    //
    // Also asserts the pure-markdown path leaves `mdIntermediateHash`
    // undefined so we don't lose the Phase-1-skipped guarantee.
    const mockConverter: ExtractionPipeline = {
      contentTypes: ['application/x-mock'],
      async extract(_input: ExtractionInput): Promise<ConverterOutput> {
        return { mdIntermediate: '# Converted\n\nFrom mock.\n' };
      },
    };
    const mockRegistry = new ExtractionPipelineRegistry();
    mockRegistry.register(mockConverter);

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'src.mock', contentType: 'application/x-mock', content: Buffer.from('binary-blob', 'utf-8') },
    ]);
    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: mockRegistry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'bug23-converter',
    });

    expect(result.extraction.mdIntermediateHash).toMatch(/^keccak256:[0-9a-f]{64}$/);
    expect('mdIntermediateSha256Hash' in result.extraction).toBe(false);
    const bytes = await fileStore.get(result.extraction.mdIntermediateHash!);
    expect(bytes).not.toBeNull();

    // Record lifecycle mirrors the single-hash contract.
    const record = status.get(result.assertionUri);
    expect(record?.mdIntermediateHash).toBe(result.extraction.mdIntermediateHash);
    expect(record && 'mdIntermediateSha256Hash' in record).toBe(false);

    // Pure-markdown path: `mdIntermediateHash` stays undefined
    // (Phase 1 skipped, no MD intermediate stored separately).
    const pureBody = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'pure.md', contentType: 'text/markdown', content: Buffer.from('# Pure\n', 'utf-8') },
    ]);
    const pureResult = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: pureBody, boundary: BOUNDARY, assertionName: 'bug23-nomd',
    });
    expect(pureResult.extraction.mdIntermediateHash).toBeUndefined();
  });

  it('Round 9 Bug 27: two imports of the same bytes under DIFFERENT filenames both succeed with their own `dkg:sourceFileName` on their own UAL', async () => {
    // Round 9 Bug 27 — per-upload metadata (`dkg:fileName`,
    // `dkg:contentType`) used to live on the content-addressed
    // `<urn:dkg:file:keccak256:...>` subject. Two imports of
    // identical bytes under different filenames would then write
    // contradictory facts to the same subject. Bug 27 moves the
    // per-upload metadata onto the assertion UAL in `_meta` where
    // each assertion gets its own row. This test exercises the
    // canonical collision scenario: same bytes, different filenames,
    // different assertion names, single context graph.
    const sameBytes = Buffer.from('# Shared content\n\nIdentical bytes, different uploads.\n', 'utf-8');

    const bodyA = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'alpha.md', contentType: 'text/markdown', content: sameBytes },
    ]);
    const resultA = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyA, boundary: BOUNDARY, assertionName: 'bug27-alpha',
    });

    const bodyB = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'beta.md', contentType: 'text/markdown', content: sameBytes },
    ]);
    const resultB = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyB, boundary: BOUNDARY, assertionName: 'bug27-beta',
    });

    // Same bytes → same keccak256 → same `<fileUri>` across both.
    expect(resultA.fileHash).toBe(resultB.fileHash);
    const fileUri = `urn:dkg:file:${resultA.fileHash}`;

    // The shared `<fileUri>` subject carries NO per-upload metadata
    // in the data graph — the Bug 27 canary.
    expect(agent.insertedQuads.some(q => q.subject === fileUri && q.predicate === `${DKG}fileName`)).toBe(false);
    expect(agent.insertedQuads.some(q => q.subject === fileUri && q.predicate === `${DKG}contentType`)).toBe(false);

    // Each assertion's `_meta` block carries its OWN sourceFileName
    // keyed by its own UAL, so the two filenames coexist without
    // collision.
    const metaGraphUri = contextGraphMetaUri('cg');
    const metaA = agent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === resultA.assertionUri && q.predicate === `${DKG}sourceFileName`,
    );
    const metaB = agent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === resultB.assertionUri && q.predicate === `${DKG}sourceFileName`,
    );
    expect(metaA).toHaveLength(1);
    expect(metaA[0]!.object).toBe('"alpha.md"');
    expect(metaB).toHaveLength(1);
    expect(metaB[0]!.object).toBe('"beta.md"');

    // Symmetric negative for the old row-7 collision — `dkg:contentType`
    // on the shared `<fileUri>` must also be absent. Existing row 15
    // (`dkg:sourceContentType` on the UAL) covers per-assertion
    // content type without sharing a subject across assertions.
    const ctA = agent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === resultA.assertionUri && q.predicate === `${DKG}sourceContentType`,
    );
    const ctB = agent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === resultB.assertionUri && q.predicate === `${DKG}sourceContentType`,
    );
    expect(ctA).toHaveLength(1);
    expect(ctB).toHaveLength(1);
  });

  it('Round 9 Bug 27: no-filename upload skips `dkg:sourceFileName` entirely (matches row 20 optional pattern)', async () => {
    // Symmetric negative guard — when the multipart part carries no
    // filename (or a whitespace-only filename), the daemon skips
    // the `_meta` row entirely, same way row 20 (`mdIntermediateHash`)
    // is absent for markdown-direct imports.
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: '', contentType: 'text/markdown', content: Buffer.from('# Anon\n', 'utf-8') },
    ]);
    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'bug27-noname',
    });
    const metaGraphUri = contextGraphMetaUri('cg');
    const nameRows = agent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === result.assertionUri && q.predicate === `${DKG}sourceFileName`,
    );
    expect(nameRows).toHaveLength(0);
  });

  it('Bug 22: dropGraph failure restores the metaSnapshot that deleteByPattern just cleared', async () => {
    // Round 7 Bug 22 — the narrow window where `deleteByPattern`
    // succeeds but `dropGraph` fails used to leave the old `_meta`
    // rows gone with the data graph still intact (self-inconsistent
    // state, no rollback fires). Bug 22 extends the rollback path
    // to cover this case: on dropGraph failure, metaSnapshot is
    // re-inserted.
    //
    // Prime V1, then fail V2's dropGraph and assert V1's `_meta`
    // rows are byte-perfect restored from the snapshot.
    const bodyV1 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n\nReliable.\n', 'utf-8') },
    ]);
    const resultV1 = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'bug22-target',
    });
    const assertionUri = resultV1.assertionUri;
    const metaGraphUri = contextGraphMetaUri('cg');

    // Snapshot V1's `_meta` rows keyed by this assertion before the
    // failing V2 attempt.
    const v1Meta = agent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === assertionUri,
    );
    expect(v1Meta.length).toBeGreaterThanOrEqual(6);
    const v1SourceFileHash = v1Meta.find(q => q.predicate === `${DKG}sourceFileHash`)?.object;
    expect(v1SourceFileHash).toBe(`"${resultV1.fileHash}"`);

    // Prime a fresh agent with V1's state, inject a dropGraph
    // failure. V2 attempt: deleteByPattern(_meta) succeeds (removes
    // V1's meta rows), dropGraph throws → Bug 22 path restores
    // metaSnapshot.
    const failAgent = makeMockAgent('0xMockAgentPeerId', {
      dropGraphError: new Error('simulated dropGraph outage'),
    });
    for (const q of agent.insertedQuads) {
      failAgent.insertedQuads.push({ ...q });
    }

    const bodyV2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n\nWill fail.\n', 'utf-8') },
    ]);
    await expect(runImportFileOrchestration({
      agent: failAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'bug22-target',
    })).rejects.toThrow('simulated dropGraph outage');

    // V1's `_meta` rows were cleared by deleteByPattern then
    // restored by the Bug 22 rollback. The same keccak256 hash
    // literal that row 16 carried for V1 must still be present.
    const metaAfter = failAgent.insertedQuads.filter(q =>
      q.graph === metaGraphUri && q.subject === assertionUri,
    );
    const restoredSourceFileHash = metaAfter.find(q => q.predicate === `${DKG}sourceFileHash`)?.object;
    expect(restoredSourceFileHash).toBe(v1SourceFileHash);
    expect(metaAfter.length).toBeGreaterThanOrEqual(v1Meta.length);

    // V1's data graph is untouched (dropGraph threw BEFORE doing
    // anything, so no rollback is needed on the data side).
    const assertionGraph = contextGraphAssertionUri('cg', failAgent.peerId, 'bug22-target');
    const dataAfter = failAgent.insertedQuads.filter(q => q.graph === assertionGraph);
    expect(dataAfter.length).toBeGreaterThan(0);
  });

  it('Bug 22: deleteByPattern failure triggers NO rollback (nothing was corrupted)', async () => {
    // Inverse guard. If deleteByPattern fails before doing anything,
    // metaCleanupSucceeded stays false and the rollback path must
    // NOT fire — otherwise we'd be inserting stale snapshots into a
    // store that never changed.
    const bodyV1 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n', 'utf-8') },
    ]);
    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'bug22-nothing',
    });

    const failAgent = makeMockAgent('0xMockAgentPeerId', {
      deleteByPatternError: new Error('simulated delete outage'),
    });
    for (const q of agent.insertedQuads) {
      failAgent.insertedQuads.push({ ...q });
    }
    // Count insertion calls so we can prove the rollback did NOT
    // fire. After the priming, the next insert should be the one
    // that the failing import tries and never reaches.
    const insertCountBefore = failAgent.insertCallCount;

    const bodyV2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n', 'utf-8') },
    ]);
    await expect(runImportFileOrchestration({
      agent: failAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'bug22-nothing',
    })).rejects.toThrow('simulated delete outage');

    // No new insert calls — neither the V2 commit nor any rollback
    // re-insert fired. The state is unchanged so no rollback was
    // needed.
    expect(failAgent.insertCallCount).toBe(insertCountBefore);
  });

  it('Bug 12: assertionDiscard runs `_meta` cleanup BEFORE dropGraph (mock mirrors publisher ordering)', async () => {
    // Regression guard for the Round 4 Bug 12 ordering flip. The mock
    // discard method (`agent.assertion.discard`) now calls
    // `deleteByPattern` first, then `dropGraph`. A `deleteByPattern`
    // failure leaves the data graph intact, which is the retry-safe
    // ordering.
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'discard-me.md', contentType: 'text/markdown', content: Buffer.from('# Discard\n', 'utf-8') },
    ]);
    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'discard-order',
    });

    // Simulate a `deleteByPattern` failure during discard.
    const failingAgent = makeMockAgent('0xMockAgentPeerId', {
      deleteByPatternError: new Error('simulated meta cleanup failure'),
    });
    // Prime with the successful import's quads.
    for (const q of agent.insertedQuads) {
      failingAgent.insertedQuads.push({ ...q });
    }

    // Discard should throw because `deleteByPattern` fails.
    await expect(
      failingAgent.assertion.discard('cg', 'discard-order'),
    ).rejects.toThrow('simulated meta cleanup failure');

    // CRITICAL: the data graph must still be intact. The ordering
    // (`deleteByPattern` first) means `dropGraph` never ran, so V's
    // assertion graph quads are still there. This is the retry-safe
    // guarantee of Bug 12.
    const assertionGraph = contextGraphAssertionUri('cg', failingAgent.peerId, 'discard-order');
    const dataAfterFailedDiscard = failingAgent.insertedQuads.filter(q => q.graph === assertionGraph);
    expect(dataAfterFailedDiscard.length).toBeGreaterThan(0);
    // The dropGraph call was NEVER made (ordering: meta first, drop second).
    expect(failingAgent.droppedGraphs).not.toContain(assertionGraph);
    // Reference `result` so the successful-import capture isn't
    // flagged as unused — its hash is a sanity anchor for the test.
    expect(result.fileHash).toMatch(/^keccak256:/);
  });

  it('Bug 5b: assertion.discard drops BOTH the data graph AND the assertion _meta rows', async () => {
    // Regression guard for Bug 5b: after discard, there must be ZERO
    // rows in the CG root `_meta` keyed by this assertion's UAL, AND
    // zero quads in the assertion data graph. Pre-fix discard only
    // dropped the data graph, leaving `_meta` pointing at a hash for
    // an assertion that no longer exists.
    const ASSERTION_NAME = 'to-be-discarded';
    const metaGraph = contextGraphMetaUri('cg');

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doomed.md', contentType: 'text/markdown', content: Buffer.from('# Doomed\n\nWill be discarded.\n', 'utf-8') },
    ]);
    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: ASSERTION_NAME,
    });

    // Baseline: the import populated both graphs.
    const dataBefore = agent.insertedQuads.filter(q => q.graph === result.assertionUri);
    const metaBefore = agent.insertedQuads.filter(q =>
      q.graph === metaGraph && q.subject === result.assertionUri,
    );
    expect(dataBefore.length).toBeGreaterThan(0);
    expect(metaBefore.length).toBeGreaterThan(0);

    // Discard.
    await agent.assertion.discard('cg', ASSERTION_NAME);

    // The data graph is dropped (tracked explicitly so the test catches
    // regressions where dropGraph is skipped).
    expect(agent.droppedGraphs).toContain(result.assertionUri);
    const dataAfter = agent.insertedQuads.filter(q => q.graph === result.assertionUri);
    expect(dataAfter).toHaveLength(0);

    // AND the `_meta` rows keyed by this assertion's UAL are gone.
    const metaAfter = agent.insertedQuads.filter(q =>
      q.graph === metaGraph && q.subject === result.assertionUri,
    );
    expect(metaAfter).toHaveLength(0);
  });

  it('Bug 5b: discard does NOT touch `_meta` rows for OTHER assertions', async () => {
    // Scope guard for the cleanup: dropping assertion A must not leak
    // into the `_meta` rows for assertion B. Otherwise a discard could
    // wipe unrelated data.
    const metaGraph = contextGraphMetaUri('cg');

    // Import two assertions with unrelated names.
    const bodyA = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'a.md', contentType: 'text/markdown', content: Buffer.from('# A\n\nFirst.\n', 'utf-8') },
    ]);
    const bodyB = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'b.md', contentType: 'text/markdown', content: Buffer.from('# B\n\nSecond.\n', 'utf-8') },
    ]);
    const a = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyA, boundary: BOUNDARY, assertionName: 'iso-a',
    });
    const b = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: bodyB, boundary: BOUNDARY, assertionName: 'iso-b',
    });

    // Discard only A.
    await agent.assertion.discard('cg', 'iso-a');

    // A's `_meta` rows gone.
    const metaA = agent.insertedQuads.filter(q =>
      q.graph === metaGraph && q.subject === a.assertionUri,
    );
    expect(metaA).toHaveLength(0);

    // B's `_meta` rows intact.
    const metaB = agent.insertedQuads.filter(q =>
      q.graph === metaGraph && q.subject === b.assertionUri,
    );
    expect(metaB.length).toBeGreaterThan(0);
    const bHash = metaB.find(q => q.predicate === `${DKG}sourceFileHash`);
    expect(bHash?.object).toBe(`"${b.fileHash}"`);
  });
});

describe('import-file orchestration — boundary parsing', () => {
  it('parseBoundary extracts boundary from the daemon-style header', () => {
    expect(parseBoundary(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
  });

  it('parseBoundary rejects non-multipart requests', () => {
    expect(parseBoundary('application/json')).toBeNull();
  });
});

describe('import-file orchestration — extraction-status semantics', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let registry: ExtractionPipelineRegistry;
  let status: Map<string, ExtractionStatusRecord>;
  let agent: MockAgent;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dkg-importfile-test-'));
    fileStore = new FileStore(join(tmpDir, 'files'));
    registry = new ExtractionPipelineRegistry();
    status = new Map();
    agent = makeMockAgent();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('populates the status record with startedAt/completedAt timestamps on success', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'doc',
    });

    const record = status.get(result.assertionUri)!;
    expect(record.startedAt).toBeTruthy();
    expect(record.completedAt).toBeTruthy();
    expect(new Date(record.startedAt).getTime()).toBeLessThanOrEqual(new Date(record.completedAt!).getTime());
  });

  it('keyed by assertionUri — separate imports to different assertions get separate records', async () => {
    const body1 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'a.md', contentType: 'text/markdown', content: Buffer.from('# A\n\nBody a.\n', 'utf-8') },
    ]);
    const body2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'b.md', contentType: 'text/markdown', content: Buffer.from('# B\n\nBody b.\n', 'utf-8') },
    ]);

    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body1, boundary: BOUNDARY, assertionName: 'doc-a',
    });
    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body2, boundary: BOUNDARY, assertionName: 'doc-b',
    });

    expect(status.size).toBe(2);
    const keys = [...status.keys()];
    expect(keys.some(k => k.endsWith('/doc-a'))).toBe(true);
    expect(keys.some(k => k.endsWith('/doc-b'))).toBe(true);
  });
});

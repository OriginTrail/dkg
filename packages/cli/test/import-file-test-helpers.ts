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
 *      using the assertion URI as the pinned import subject; if frontmatter
 *      resolves a different `rootEntity`, the public import-file path rejects
 *      that divergent override with a 400 until the broader promote/update
 *      identity plumbing lands
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
  assertionLifecycleUri,
} from '@origintrail-official/dkg-core';
import { autoPartition, findReservedSubjectPrefix, isSkolemizedUri } from '@origintrail-official/dkg-publisher';
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
  publisher: {
    assertionCreate: (
      contextGraphId: string,
      name: string,
      agentAddress: string,
      subGraphName?: string,
    ) => Promise<string>;
  };
  store: {
    insert: (quads: CapturedQuad[]) => Promise<void>;
    createGraph: (graphUri: string) => Promise<void>;
    hasGraph: (graphUri: string) => Promise<boolean>;
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
  createdAssertions: Array<{ contextGraphId: string; name: string; agentAddress: string; subGraphName?: string }>;
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
  insertPartialBeforeErrorPredicate?: (quads: CapturedQuad[], callNumber: number) => CapturedQuad[] | null;
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
  const createdAssertions: Array<{ contextGraphId: string; name: string; agentAddress: string; subGraphName?: string }> = [];
  const insertedQuads: CapturedQuad[] = [];
  const createdGraphs = new Set<string>();
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
        return agent.publisher.assertionCreate(contextGraphId, name, peerId, opts?.subGraphName);
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
    publisher: {
      async assertionCreate(
        contextGraphId: string,
        name: string,
        agentAddress: string,
        subGraphName?: string,
      ): Promise<string> {
        if (options.createError) throw options.createError;
        createdAssertions.push({ contextGraphId, name, agentAddress, subGraphName });
        return contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
      },
    },
    store: {
      async insert(quads: CapturedQuad[]): Promise<void> {
        insertCallCount++;
        if (options.insertError) throw options.insertError;
        if (options.insertPartialBeforeErrorPredicate) {
          const partialQuads = options.insertPartialBeforeErrorPredicate(quads, insertCallCount);
          if (partialQuads?.length) insertedQuads.push(...partialQuads);
        }
        if (options.insertErrorPredicate) {
          const err = options.insertErrorPredicate(quads, insertCallCount);
          if (err) throw err;
        }
        insertedQuads.push(...quads);
      },
      async createGraph(graphUri: string): Promise<void> {
        createdGraphs.add(graphUri);
      },
      async hasGraph(graphUri: string): Promise<boolean> {
        return createdGraphs.has(graphUri) || insertedQuads.some(q => q.graph === graphUri);
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
        createdGraphs.delete(graphUri);
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
        if (/^\s*SELECT\s+DISTINCT\s+\?s/i.test(sparql)) {
          const graphMatch = /GRAPH\s+<([^>]+)>/.exec(sparql);
          if (!graphMatch) {
            return { type: 'bindings', bindings: [] };
          }
          const targetGraph = graphMatch[1]!;
          const literals = Array.from(sparql.matchAll(/"((?:[^"\\]|\\.)*)"/g))
            .map(match => JSON.parse(`"${match[1]}"`) as string);
          const exactSubjects = literals.filter(value => !value.endsWith('/'));
          const subjectPrefixes = literals.filter(value => value.endsWith('/'));
          const subjects = new Set(
            insertedQuads
              .filter(q =>
                q.graph === targetGraph
                && (
                  exactSubjects.includes(q.subject)
                  || subjectPrefixes.some(prefix => q.subject.startsWith(prefix))
                )
              )
              .map(q => q.subject),
          );
          return {
            type: 'bindings',
            bindings: Array.from(subjects).map(s => ({ s })),
          };
        }
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

export { describe, it, expect, beforeEach, afterEach, mkdtemp, rm, readFile, tmpdir, join, existsSync, randomUUID };
export { ExtractionPipelineRegistry, contextGraphAssertionUri, contextGraphMetaUri, assertionLifecycleUri, autoPartition, findReservedSubjectPrefix, isSkolemizedUri, FileStore, parseBoundary, parseMultipart, extractFromMarkdown };
export { makeMockAgent, getDataGraphQuads, ImportFileRouteError, buildImportFileResponse, normalizeDetectedContentType, BOUNDARY, CRLF, buildMultipart };
export type { ExtractionPipeline, ExtractionInput, ConverterOutput, ExtractionStatusRecord, CapturedQuad, MockAgent, MockAgentOptions, ImportFileResult };

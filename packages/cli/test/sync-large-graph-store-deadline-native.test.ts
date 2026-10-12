import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  contextGraphAssertionUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  MemoryLayer,
} from '@origintrail-official/dkg-core';
import {
  generateAssertionCreatedMetadata,
  generateAssertionPromotedMetadata,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import { createManagedOxigraphSparqlStoreV1, type TripleStore } from '@origintrail-official/dkg-storage';
import { readSyncNotServable } from '../../agent/src/sync/not-servable.js';
import { linesFromNquads, registerTestSyncHandler } from '../../agent/test/_helpers/sync-responder.js';
import { resolveOxigraphBinary } from '../src/daemon/oxigraph-binary.js';
import { startOxigraphServer, type OxigraphServerHandle } from '../src/daemon/oxigraph-server.js';
import { freePort, waitForCondition } from './fixtures/oxigraph-server-real-fixture.js';

/**
 * The sync responder against the pinned real Oxigraph executable, with the
 * store's own client deadline and supervised recovery: no store double and no
 * fake clock anywhere on the deadline path.
 *
 * Two properties are checked. The cost of a metadata page follows the page,
 * also for a graph far past the responder's snapshot budget, so every page
 * stays well inside the store deadline. And a request that did run into the
 * deadline is not run a second time while its shape cools.
 *
 * The graph holds the two shapes metadata comes in: published asset
 * descriptors, and named assertions that were promoted (a lifecycle record,
 * its events and the seal kept under the assertion's own path).
 *
 * The production snapshot budget (200,000 rows) and deadline (30 s) are scaled
 * down together so the same shape runs in seconds: a metadata graph of about
 * 130,000 rows against a 4,000-row snapshot budget and a 5 s deadline. The
 * session plan that pages this graph is built in about a second.
 */

const ASSETS = 6_000;
/** Rows the publisher writes per confirmed asset descriptor. */
const DESCRIPTOR_ROWS = 16;
const ASSERTIONS = 1_200;
/** Rows of the seal a promoted assertion keeps under its own path. */
const SEAL_ROWS = 14;
const CONTEXT_GRAPH_ID = 'native-large-meta';
const META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_meta`;
const SCALED_SNAPSHOT_BUDGET = {
  maxRows: 1_000_000,
  maxBytesEstimate: 1024 ** 3,
  maxSnapshotRows: 4_000,
  maxSnapshotBytesEstimate: 512 * 1024 * 1024,
} as const;

function term(value: string): string {
  return value.startsWith('"') ? value : `<${value}>`;
}

/** The metadata of named assertions after promotion, as the publisher leaves it. */
function promotedAssertionLines(): string[] {
  const lines: string[] = [];
  for (let index = 0; index < ASSERTIONS; index += 1) {
    const agentAddress = `0x${((index % 8) + 1).toString(16).padStart(40, 'b')}`;
    const meta = {
      contextGraphId: CONTEXT_GRAPH_ID,
      agentAddress,
      assertionName: `notes-${index}`,
      timestamp: new Date(Date.UTC(2026, 6, 1) + index * 60_000),
    };
    const promoted = generateAssertionPromotedMetadata({
      ...meta,
      shareOperationId: `share-${index}`,
      rootEntities: [`urn:synthetic:root:${index}`],
    });
    const removed = new Set(promoted.delete.map((quad) => `${quad.subject}\n${quad.predicate}\n${quad.object}`));
    const quads = [
      ...generateAssertionCreatedMetadata(meta)
        .filter((quad) => !removed.has(`${quad.subject}\n${quad.predicate}\n${quad.object}`)),
      ...promoted.insert,
    ];
    for (const quad of quads) {
      lines.push(`${term(quad.subject)} <${quad.predicate}> ${term(quad.object)} <${quad.graph}> .`);
    }
    const seal = contextGraphAssertionUri(CONTEXT_GRAPH_ID, agentAddress, meta.assertionName);
    for (let row = 0; row < SEAL_ROWS; row += 1) {
      lines.push(`<${seal}> <http://dkg.io/ontology/syntheticSealField${row}> "seal-${index}-${row}" <${META_GRAPH}> .`);
    }
  }
  return lines;
}

function syntheticMetadataLines(): string[] {
  const lines: string[] = [
    `<did:dkg:context-graph:${CONTEXT_GRAPH_ID}> <http://schema.org/name> "${CONTEXT_GRAPH_ID}" <${META_GRAPH}> .`,
    ...promotedAssertionLines(),
  ];
  for (let index = 0; index < ASSETS; index += 1) {
    const author = `0x${((index % 8) + 1).toString(16).padStart(40, 'a')}`;
    const ual = `did:dkg:base:84532/${author}/${Math.floor(index / 8) + 1}`;
    const quads = generateGraphKnowledgeAssetMetadata({
      ual,
      contextGraphId: CONTEXT_GRAPH_ID,
      merkleRoot: Uint8Array.from({ length: 32 }, (_, byte) => (index * 31 + byte) & 0xff),
      publisherPeerId: `12D3KooWSyntheticPublisher${index % 8}`,
      agentAddress: author,
      accessPolicy: 'public',
      timestamp: new Date(Date.UTC(2026, 5, 1) + index * 60_000),
      assertionVersion: 1,
      publicTripleCount: 5,
      privateTripleCount: 0,
      assertionGraph: knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH_ID,
        MemoryLayer.VerifiableMemory,
        createGraphKnowledgeAssetScope(ual, 1),
      ),
    }, {
      status: 'confirmed',
      confirmation: {
        kind: 'transaction',
        provenance: {
          txHash: `0x${index.toString(16).padStart(64, '0')}`,
          blockNumber: 1_000_000 + index,
          blockTimestamp: 1_780_000_000 + index,
          publisherAddress: author,
          batchId: BigInt(index + 1),
          chainId: 'base:84532',
        },
      },
    });
    expect(quads).toHaveLength(DESCRIPTOR_ROWS);
    for (const quad of quads) {
      lines.push(`${term(quad.subject)} <${quad.predicate}> ${term(quad.object)} <${quad.graph}> .`);
    }
  }
  return lines;
}

async function run(binaryPath: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`oxigraph ${args[0]} exited ${code}: ${stderr.trim().slice(-400)}`));
    });
  });
}

let binaryPath = process.env.DKG_OXIGRAPH_TEST_BINARY;
let nquadsFile: string;
let fixtureDirectory: string;
/** Every row of the fixture is durable metadata, so a whole walk serves this many. */
let metadataRows: number;

interface Responder {
  handle: OxigraphServerHandle;
  store: TripleStore;
  storeQueries: { count: number };
  metaPage(offset: number, rowsHint: number, syncSessionId: string): Promise<string>;
}

const cleanups: Array<() => Promise<void>> = [];

async function startResponder(options: {
  clientDeadlineMs: number;
  snapshotBudget?: typeof SCALED_SNAPSHOT_BUDGET;
}): Promise<Responder> {
  const location = await mkdtemp(join(tmpdir(), 'oxi-native-sync-deadline-'));
  // Bulk-load before the server owns the store directory.
  await run(binaryPath!, ['load', '--location', location, '--file', nquadsFile]);
  const port = await freePort();
  const handle = await startOxigraphServer({
    binaryPath: binaryPath!,
    location,
    port,
    readyTimeoutMs: 20_000,
    readyIntervalMs: 50,
    stopGraceMs: 2_000,
    restartBackoffBaseMs: 100,
    restartBackoffMaxMs: 200,
    log: () => {},
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const store = createManagedOxigraphSparqlStoreV1({
    queryEndpoint: `${endpoint}/query`,
    updateEndpoint: `${endpoint}/update`,
    timeout: options.clientDeadlineMs,
  }, {
    getRecoveryState: () => handle.getRecoveryState(),
    registerActivity: () => handle.registerStoreActivity(),
    onClientTimeout: (operation) => handle.requestRestart(`${operation} exceeded the client deadline`),
    requestRecovery: (generation, operation) =>
      handle.requestRecovery!(generation, `${operation} exceeded the client deadline`),
  });
  cleanups.push(async () => {
    await store.close();
    await handle.stop();
    await rm(location, { recursive: true, force: true });
  });
  const storeQueries = { count: 0 };
  const query = store.query.bind(store);
  (store as { query: TripleStore['query'] }).query = (sparql, queryOptions) => {
    storeQueries.count += 1;
    return query(sparql, queryOptions);
  };
  const cap = registerTestSyncHandler(store, {
    syncPageSize: 8192,
    ...(options.snapshotBudget ? { snapshotBudget: options.snapshotBudget } : {}),
  });
  return {
    handle,
    store,
    storeQueries,
    metaPage: (offset, rowsHint, syncSessionId) => cap.invoke({
      contextGraphId: CONTEXT_GRAPH_ID,
      includeSharedMemory: false,
      phase: 'meta',
      offset,
      limit: 500,
      pageMode: 'byte-budget-v1',
      pageRowsHint: rowsHint,
      syncSessionId,
    }),
  };
}

describe('sync of a large graph against a real store deadline (pinned real Oxigraph executable)', () => {
  beforeAll(async () => {
    if (!binaryPath) {
      binaryPath = (await resolveOxigraphBinary({
        cacheDir: join(tmpdir(), 'dkg-required-oxigraph-test-binary'),
        log: () => {},
      })).path;
    }
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'oxi-native-sync-fixture-'));
    nquadsFile = join(fixtureDirectory, 'large-meta.nq');
    const lines = syntheticMetadataLines();
    metadataRows = new Set(lines).size;
    await writeFile(nquadsFile, `${lines.join('\n')}\n`);
    return async () => { await rm(fixtureDirectory, { recursive: true, force: true }); };
  }, 120_000);

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it('serves pages of a metadata graph far past the snapshot budget within the deadline, with no supervised recovery', async () => {
    const clientDeadlineMs = 5_000;
    const responder = await startResponder({ clientDeadlineMs, snapshotBudget: SCALED_SNAPSHOT_BUDGET });

    const timings: Array<{ offset: number; rows: number; ms: number }> = [];
    let offset = 0;
    // The smallest page a requester falls back to, then its ordinary sizes.
    for (const rowsHint of [64, 512, 8192, 8192]) {
      const startedAt = performance.now();
      const lines = linesFromNquads(await responder.metaPage(offset, rowsHint, 'native-session'));
      timings.push({ offset, rows: lines.length, ms: Math.round(performance.now() - startedAt) });
      // Whole descriptors, as many as the page asked for.
      expect(lines.length).toBe(rowsHint);
      expect(lines.length % DESCRIPTOR_ROWS).toBe(0);
      offset += lines.length;
    }

    // The rest of the walk: the remaining descriptors, then the seals of the
    // promoted assertions, their lifecycle records and events.
    const served = new Set<string>();
    let sealRows = 0;
    let slowestLaterMs = 0;
    for (let guard = 0; guard < 200; guard += 1) {
      const startedAt = performance.now();
      const lines = linesFromNquads(await responder.metaPage(offset, 8192, 'native-session'));
      slowestLaterMs = Math.max(slowestLaterMs, Math.round(performance.now() - startedAt));
      if (lines.length === 0) break;
      for (const line of lines) {
        served.add(line);
        if (line.includes('/assertion/0x')) sealRows += 1;
      }
      offset += lines.length;
    }

    // eslint-disable-next-line no-console
    console.log(`[sync-large-graph] ${ASSETS} assets and ${ASSERTIONS} promoted assertions, ${metadataRows} metadata rows: `
      + `${JSON.stringify(timings)}, slowest later page ${slowestLaterMs} ms`);
    // No page came near the deadline, the first included.
    for (const timing of timings) expect(timing.ms).toBeLessThan(clientDeadlineMs);
    expect(slowestLaterMs).toBeLessThan(clientDeadlineMs);
    // The walk served every row of the graph, the seals of every assertion among them.
    expect(offset).toBe(metadataRows);
    expect(sealRows).toBe(ASSERTIONS * SEAL_ROWS);
    // No query had to be reclaimed by a supervised recovery.
    expect(responder.handle.getRecoveryState()).toMatchObject({ recovering: false, generation: 0 });
  }, 120_000);

  it('runs a request that hit the store deadline once, then refuses it without touching the store', async () => {
    // With the production snapshot budget the first page reads the whole graph
    // in one query, which cannot finish in 100 ms: a request that really does
    // not fit this store's deadline.
    const responder = await startResponder({ clientDeadlineMs: 100 });

    await expect(responder.metaPage(0, 64, 'first')).rejects.toMatchObject({
      code: 'STORE_OPERATION_TIMEOUT',
      backend: 'oxigraph-server',
    });
    // Let the supervised recovery that follows a client deadline finish.
    expect(await waitForCondition(() => {
      const state = responder.handle.getRecoveryState();
      return state.generation === 1 && !state.recovering;
    }, 20_000)).toBe(true);
    const queriesAfterFailure = responder.storeQueries.count;

    for (const session of ['second', 'third']) {
      const refusal = await responder.metaPage(0, 64, session).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ name: 'QuietRetryableHandlerError' });
      expect(readSyncNotServable(refusal)).toMatchObject({ reason: 'store-deadline' });
      expect(readSyncNotServable(refusal)!.retryAfterMs).toBeGreaterThan(9 * 60_000);
    }
    // Nothing was run for the refused requests, so no further recovery followed.
    expect(responder.storeQueries.count).toBe(queriesAfterFailure);
    expect(responder.handle.getRecoveryState()).toMatchObject({ recovering: false, generation: 1 });
  }, 60_000);
});

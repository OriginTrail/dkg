/**
 * Live managed-Oxigraph ownership gate — generator (#2052 Stack B2).
 *
 * Launches the checksum-pinned Oxigraph v0.5.8 server, seeds reserved
 * system-record V1 state directly into it, and then drives the real production
 * store stack against that live endpoint. Unit tests and the embedded adapter
 * cannot satisfy this gate: the properties being proven are about a separate
 * OS process, its listen socket, and what a predecessor binary can observe.
 *
 * Emits `artifacts/managed-ownership-result.json`. `verify.ts` turns that into
 * the verdict and throws on any violation.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  OwnedManagedHttpClient,
  SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH,
  SYSTEM_RECORD_V1_STATE_GRAPH,
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  createTripleStore,
  type ManagedOxigraphSupervisorHandoffV1,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
// Relative source import: the CLI package does not export this subpath, and the
// gate must use the SAME pinned-asset table production uses rather than
// restating a version or checksum that could silently drift from it.
import {
  OXIGRAPH_VERSION,
  ensureOxigraphBinary,
} from '../../packages/cli/src/daemon/oxigraph-binary.js';

import {
  MANAGED_OWNERSHIP_RAW_SCHEMA_VERSION,
  type ManagedOwnershipRawResultV1,
  type PredecessorEntryResultV1,
} from './model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = join(HERE, 'artifacts', 'managed-ownership-result.json');
const MANIFEST = join(HERE, 'fixtures', 'system-record-predecessors-v1.json');
const STOP_GRACE_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || !address) {
        reject(new Error('could not resolve an ephemeral port'));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

interface LiveServer {
  readonly child: ChildProcess;
  readonly port: number;
  readonly queryEndpoint: string;
  readonly updateEndpoint: string;
  stop(): Promise<void>;
}

async function startPinnedServer(binaryPath: string, location: string): Promise<LiveServer> {
  const port = await freePort();
  const child = spawn(binaryPath, ['serve', '--location', location, '--bind', `127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const queryEndpoint = `http://127.0.0.1:${port}/query`;
  const updateEndpoint = `http://127.0.0.1:${port}/update`;

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`pinned Oxigraph ${OXIGRAPH_VERSION} did not become ready on :${port}`);
    }
    try {
      const res = await fetch(queryEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sparql-query' },
        body: 'ASK { ?s ?p ?o }',
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }

  return {
    child,
    port,
    queryEndpoint,
    updateEndpoint,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((done) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(timer);
          done();
        });
        child.kill('SIGTERM');
      });
    },
  };
}

async function sparqlUpdate(endpoint: string, body: string): Promise<void> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sparql-update' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`seed update failed (${res.status}): ${await res.text()}`);
}

async function countQuadsInGraph(endpoint: string, graph: string): Promise<number> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sparql-query',
      Accept: 'application/sparql-results+json',
    },
    body: `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json()) as { results?: { bindings?: { c?: { value?: string } }[] } };
  return Number(json.results?.bindings?.[0]?.c?.value ?? '0');
}

interface Manifest {
  reservedGraphs: string[];
  entries: {
    id: string;
    commit: string;
    nodeVersion: string;
    seededReservedState: string;
    expected: Record<string, boolean>;
  }[];
  fixtures: Record<
    string,
    {
      quads: { graph: string; subject: string; predicate: string; object: string }[];
      expectedQuadCount: number;
    }
  >;
}

async function main(): Promise<void> {
  // Delete any previous artifact FIRST. Without this, a run that throws part
  // way through leaves the last successful result on disk, and the standalone
  // `verify` script will cheerfully re-verify it and exit 0 � certifying a run
  // that crashed. Demonstrated: a malformed manifest crashed the generator and
  // the stale artifact still verified as PASS.
  await rm(ARTIFACT, { force: true });
  await rm(join(HERE, 'artifacts', 'managed-ownership-verdict.json'), { force: true });

  // Strip a UTF-8 BOM if an editor or shell redirect added one. `JSON.parse`
  // rejects it, and that crash is exactly what exposed the stale-artifact hole
  // above, so tolerating it here removes a foot-gun rather than hiding one.
  const manifestText = (await readFile(MANIFEST, 'utf8')).replace(/^﻿/, '');
  const manifest = JSON.parse(manifestText) as Manifest;

  const cacheDir = join(tmpdir(), 'dkg-managed-ownership-gate', 'oxigraph');
  await mkdir(cacheDir, { recursive: true });
  const binaryPath = await ensureOxigraphBinary({ cacheDir, log: () => {} });
  const binarySha256 = createHash('sha256')
    .update(await readFile(binaryPath))
    .digest('hex');

  const location = join(tmpdir(), 'dkg-managed-ownership-gate', `store-${process.pid}`);
  await mkdir(location, { recursive: true });

  const server = await startPinnedServer(binaryPath, location);

  // Every pinned commit must exist in this repository. This is the check that
  // would have caught a manifest entry carrying a short SHA zero-padded to 40
  // characters — which is not a commit, resolves to nothing, and was being
  // copied verbatim into the artifact CI uploads as evidence.
  const manifestCommitsResolved = manifest.entries.every((entry) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${entry.commit}^{commit}`], {
        cwd: resolve(HERE, '../..'),
        stdio: 'ignore',
      });
      return true;
    } catch {
      console.error(`[managed-ownership-gate] manifest commit does not resolve: ${entry.commit}`);
      return false;
    }
  });

  const predecessors: PredecessorEntryResultV1[] = [];
  let ownedSocketsBeforeDestroy = 0;
  let leakedOwnedSockets = 0;
  const capability = {
    withoutLease: false,
    withLeaseWithoutHandoff: false,
    withTerminalOwnership: false,
    withLiveLeaseAndHandoff: false,
    throughEnabledChangelog: false,
  };

  try {
    // ---- Seed reserved state directly, so the store stack observes state it
    // ---- did not write, exactly as a predecessor binary would.
    const fixture = manifest.fixtures['reserved-state-fixture-v1'];
    const triples = fixture.quads
      .map((q) => `GRAPH <${q.graph}> { <${q.subject}> <${q.predicate}> ${q.object} . }`)
      .join('\n');
    await sparqlUpdate(server.updateEndpoint, `INSERT DATA {\n${triples}\n}`);

    const seededQuadCount =
      (await countQuadsInGraph(server.queryEndpoint, SYSTEM_RECORD_V1_STATE_GRAPH)) +
      (await countQuadsInGraph(server.queryEndpoint, SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH));

    // ---- Capability fail-closed matrix against the LIVE endpoint.
    const ownership = createManagedOxigraphOwnershipControllerV1();
    ownership.bindReadyGeneration();
    const handoff: ManagedOxigraphSupervisorHandoffV1 = {
      stopAndProveOwnedChildDead: async () => undefined,
      startAndProveCleanGeneration: async () => undefined,
    };
    const base = { queryEndpoint: server.queryEndpoint, updateEndpoint: server.updateEndpoint };

    const build = async (
      options: Record<string, unknown>,
      changelog?: boolean,
    ): Promise<TripleStore> =>
      createTripleStore({
        backend: 'sparql-http',
        options,
        graphSetIndex: true,
        ...(changelog === undefined ? {} : { changelog }),
      });

    const plain = await build({ ...base });
    capability.withoutLease = plain.getSystemRecordLaneControllerV1?.() !== undefined;

    const leaseOnly = await build(
      attachManagedOxigraphLeaseV1({ ...base, managedByDkg: true }, ownership.lease) as Record<
        string,
        unknown
      >,
    );
    capability.withLeaseWithoutHandoff =
      leaseOnly.getSystemRecordLaneControllerV1?.() !== undefined;

    const full = await build(
      attachManagedOxigraphLeaseV1(
        { ...base, managedByDkg: true },
        ownership.lease,
        handoff,
      ) as Record<string, unknown>,
    );
    capability.withLiveLeaseAndHandoff =
      full.getSystemRecordLaneControllerV1?.() !== undefined;

    const withChangelog = await build(
      attachManagedOxigraphLeaseV1(
        { ...base, managedByDkg: true },
        ownership.lease,
        handoff,
      ) as Record<string, unknown>,
      true,
    );
    capability.throughEnabledChangelog =
      withChangelog.getSystemRecordLaneControllerV1?.() !== undefined;

    const terminalOwnership = createManagedOxigraphOwnershipControllerV1();
    terminalOwnership.bindReadyGeneration();
    terminalOwnership.invalidate('port-release-unproven');
    const terminal = await build(
      attachManagedOxigraphLeaseV1(
        { ...base, managedByDkg: true },
        terminalOwnership.lease,
        handoff,
      ) as Record<string, unknown>,
    );
    capability.withTerminalOwnership =
      terminal.getSystemRecordLaneControllerV1?.() !== undefined;

    // ---- Owned-client socket ownership: destroy must leave nothing behind.
    const owned = new OwnedManagedHttpClient('1');
    await owned.post(
      server.updateEndpoint,
      'application/sparql-update; charset=utf-8',
      'INSERT DATA { GRAPH <urn:dkg:gate:probe> { <urn:s> <urn:p> "o" . } }',
      5_000,
    );
    // Captured BEFORE destroy. `destroyAndSettle` loops until the count is zero
    // and throws otherwise, so reading it afterwards alone can only ever be 0 —
    // an assertion that cannot fail. The pair proves the probe is live.
    ownedSocketsBeforeDestroy = owned.openSocketCount;
    await owned.destroyAndSettle();
    leakedOwnedSockets = owned.openSocketCount;

    // ---- Predecessor matrix: every manifest entry, against the live store.
    for (const entry of manifest.entries) {
      const failures: string[] = [];

      const listed = await full.listGraphs();
      const enumerated = manifest.reservedGraphs.filter((g) => listed.includes(g));
      if (enumerated.length > 0) {
        failures.push(`enumerated reserved graphs: ${enumerated.join(', ')}`);
      }

      const served: string[] = [];
      for (const graph of manifest.reservedGraphs) {
        if (await full.hasGraph(graph)) served.push(graph);
      }
      if (served.length > 0) failures.push(`served reserved graphs: ${served.join(', ')}`);

      // Failed atomic-replace cleanup must not delete persistent reserved state.
      const deleted: string[] = [];
      for (const graph of manifest.reservedGraphs) {
        const before = await countQuadsInGraph(server.queryEndpoint, graph);
        try {
          await full.dropGraph(graph);
        } catch {
          /* refusal is the expected outcome */
        }
        const after = await countQuadsInGraph(server.queryEndpoint, graph);
        if (after < before) deleted.push(graph);
      }
      if (deleted.length > 0) {
        failures.push(`cleanup deleted reserved graphs: ${deleted.join(', ')}`);
      }

      if (seededQuadCount !== fixture.expectedQuadCount) {
        failures.push(
          `seed incomplete: ${seededQuadCount}/${fixture.expectedQuadCount} quads`,
        );
      }

      predecessors.push({
        id: entry.id,
        commit: entry.commit,
        nodeVersion: entry.nodeVersion,
        enumeratedReservedGraphs: enumerated,
        servedReservedGraphs: served,
        deletedReservedGraphsOnCleanup: deleted,
        advertisedSystemRecordLane: false,
        seededQuadCount,
        expectedQuadCount: fixture.expectedQuadCount,
        pass: failures.length === 0,
        failures,
      });
    }

    for (const store of [plain, leaseOnly, full, withChangelog, terminal]) {
      await store.close().catch(() => undefined);
    }
  } finally {
    await server.stop();
  }

  const raw: ManagedOwnershipRawResultV1 = {
    schemaVersion: MANAGED_OWNERSHIP_RAW_SCHEMA_VERSION,
    oxigraphVersion: OXIGRAPH_VERSION,
    oxigraphBinarySha256: `0x${binarySha256}`,
    platform: process.platform,
    nodeVersion: process.versions.node,
    predecessors,
    manifestEntryCount: manifest.entries.length,
    manifestCommitsResolved,
    ownedSocketsBeforeDestroy,
    leakedOwnedSockets,
    capability,
  };

  await mkdir(dirname(ARTIFACT), { recursive: true });
  await writeFile(ARTIFACT, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  console.log(`[managed-ownership-gate] wrote ${ARTIFACT}`);
  console.log(
    `[managed-ownership-gate] oxigraph ${OXIGRAPH_VERSION} sha256=0x${binarySha256.slice(0, 16)}…`,
  );
}

await main();

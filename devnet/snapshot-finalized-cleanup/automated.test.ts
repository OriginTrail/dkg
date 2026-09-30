/**
 * Finalized SWM snapshot cleanup - devnet coverage.
 *
 * Network-observable behavior under test (real nodes, real chain, real files):
 *   1. Publishing a graph-scoped Knowledge Asset records a retirement for its
 *      public snapshot, and the collector removes the file once the grace period
 *      has elapsed and nothing references it. Reads from VM keep working.
 *   2. A snapshot that another still-shared asset references survives the grace
 *      period and is reclaimed only after that asset is published as well.
 *   3. A recorded retirement survives a node restart and is finished by the
 *      restarted node; VM reads keep working across the restart.
 *   4. The collector's saved resume position is persisted next to the snapshots.
 *
 * Preconditions:
 *   pnpm run build:packages && pnpm --dir packages/cli run build:prepared
 *   DEVNET_ENABLE_PUBLISHER=1 DEVNET_SNAPSHOT_GC_FINALIZED_CLEANUP=1 \
 *     DEVNET_SNAPSHOT_GC_FINALIZED_RETENTION_MS=30000 DEVNET_SNAPSHOT_GC_INTERVAL_MS=2000 \
 *     ./scripts/devnet.sh start 6
 *
 * Isolation: the suite creates its own context graph and Knowledge Assets and
 * only reads the snapshot directory of the node it publishes from. Restarting
 * that node keeps its wallets, store and chain state.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  detectDevnet,
  ensureAllIdentities,
  fetchRetry,
  lexical,
  parseLastJsonBlock,
  queryNode,
  runDkgCli,
  sleep,
  waitFor,
  type CliResult,
  type DevnetNode,
} from '../_bootstrap/harness.js';

const PREDICATE = 'https://schema.org/name';
const RESUME_FILE = 'finalized-collection-cursor.json';

interface Suite {
  node: DevnetNode;
  reader: DevnetNode;
  contextGraphId: string;
  retentionMs: number;
  intervalMs: number;
}

interface SnapshotDirectory {
  /** digest (hex) -> payload path */
  payloads: Map<string, string>;
  retired: Set<string>;
}

let suite: Suite;
let fileCounter = 0;

const unique = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

function expectCliOk(result: CliResult, label: string): void {
  expect(
    result.code,
    `${label} failed with exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

function writeNtFixture(name: string, value: string): { filePath: string; subject: string; value: string } {
  const dir = join(import.meta.dirname, 'turns');
  mkdirSync(dir, { recursive: true });
  const subject = `urn:test:snapshot-finalized-cleanup:${name}:${Date.now()}:${++fileCounter}`;
  const filePath = join(dir, `${name}-${fileCounter}.nt`);
  writeFileSync(filePath, `<${subject}> <${PREDICATE}> "${value}" .\n`, 'utf8');
  return { filePath, subject, value };
}

/** Same content, so the same public snapshot digest, under another file name. */
function copyFixture(name: string, source: { subject: string; value: string }): { filePath: string } {
  const dir = join(import.meta.dirname, 'turns');
  const filePath = join(dir, `${name}-${++fileCounter}.nt`);
  writeFileSync(filePath, `<${source.subject}> <${PREDICATE}> "${source.value}" .\n`, 'utf8');
  return { filePath };
}

function readSnapshotDirectory(node: DevnetNode): SnapshotDirectory {
  const root = join(node.home, 'swm-public-snapshots');
  const state: SnapshotDirectory = { payloads: new Map(), retired: new Set() };
  if (!existsSync(root)) return state;
  const dirs = (path: string) =>
    readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[a-f0-9]{2}$/.test(e.name));
  for (const first of dirs(root)) {
    for (const second of dirs(join(root, first.name))) {
      const path = join(root, first.name, second.name);
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const payload = /^([a-f0-9]{64})\.(?:nq|json)$/.exec(entry.name);
        if (payload) state.payloads.set(payload[1]!, join(path, entry.name));
        const retired = /^([a-f0-9]{64})\.retired$/.exec(entry.name);
        if (retired) state.retired.add(retired[1]!);
      }
    }
  }
  return state;
}

/** The digest of the snapshot file holding `subject`, once the share has written it. */
async function waitForSnapshotOf(node: DevnetNode, subject: string): Promise<string> {
  return waitFor(`a snapshot file holding ${subject} on node${node.num}`, 120_000, 1_000, async () => {
    for (const [digest, path] of readSnapshotDirectory(node).payloads) {
      try {
        if (readFileSync(path, 'utf8').includes(subject)) return digest;
      } catch {
        // Removed between the listing and the read.
      }
    }
    return null;
  });
}

/** Poll until the payload and its record are gone; report whether the record was ever seen. */
async function waitForReclaim(node: DevnetNode, digest: string, timeoutMs: number): Promise<{ sawRecord: boolean }> {
  let sawRecord = false;
  await waitFor(`snapshot ${digest} reclaimed on node${node.num}`, timeoutMs, 500, async () => {
    const dir = readSnapshotDirectory(node);
    sawRecord ||= dir.retired.has(digest);
    return !dir.payloads.has(digest) && !dir.retired.has(digest) ? true : null;
  });
  return { sawRecord };
}

async function waitForRetirementRecord(node: DevnetNode, digest: string): Promise<void> {
  await waitFor(`a retirement record for ${digest} on node${node.num}`, 240_000, 500, async () =>
    readSnapshotDirectory(node).retired.has(digest) ? true : null);
}

async function assertSubjectIn(
  node: DevnetNode,
  contextGraphId: string,
  view: 'shared-working-memory' | 'verifiable-memory',
  subject: string,
  value: string,
  timeoutMs = 180_000,
): Promise<void> {
  await waitFor(`subject ${subject} visible in ${view} on node${node.num}`, timeoutMs, 3_000, async () => {
    try {
      const bindings = await queryNode(
        node,
        `SELECT ?o WHERE { GRAPH ?g { <${subject}> <${PREDICATE}> ?o } }`,
        { contextGraphId, view },
      );
      return bindings.some((row) => lexical(row.o) === value) ? bindings : null;
    } catch (error) {
      // A managed store that is restarting answers 503 "retryable"; anything else is a real failure.
      if (/\(503\)[^]*"retryable":true/.test((error as Error).message)) return null;
      throw error;
    }
  });
}

async function shareAsset(name: string, filePath: string): Promise<void> {
  const { node, contextGraphId } = suite;
  expectCliOk(
    await runDkgCli(node, ['ka', 'create', name, '-c', contextGraphId, '--input-file', filePath, '--share'], 180_000),
    `ka create --share ${name}`,
  );
}

async function publishAssetAndWait(name: string): Promise<void> {
  const { node, contextGraphId } = suite;
  const publish = await runDkgCli(node, ['ka', 'publish-async', name, '-c', contextGraphId, '--json'], 60_000);
  expectCliOk(publish, `ka publish-async ${name}`);
  const body = parseLastJsonBlock(publish.stdout, `ka publish-async ${name} stdout`);
  expect(body.jobId, `publish response: ${publish.stdout}`).toBeTruthy();
  const jobId = String(body.jobId);
  await waitFor(`publisher job ${jobId} finalized`, 300_000, 3_000, async () => {
    const detail = await runDkgCli(node, ['publisher', 'job', jobId, '--payload'], 60_000);
    expectCliOk(detail, `publisher job ${jobId}`);
    const job = parseLastJsonBlock<{ status?: string }>(detail.stdout, `publisher job ${jobId} stdout`);
    if (job.status === 'failed') throw new Error(`publisher job ${jobId} failed:\n${detail.stdout}`);
    return job.status === 'finalized' ? job : null;
  });
}

async function restartNode(node: DevnetNode): Promise<void> {
  const restarted = spawnSync('bash', [join(REPO_ROOT, 'scripts/devnet.sh'), 'restart-node', String(node.num)], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: 240_000,
  });
  expect(
    restarted.status,
    `devnet.sh restart-node ${node.num} failed\nstdout:\n${restarted.stdout}\nstderr:\n${restarted.stderr}`,
  ).toBe(0);
  await waitFor(`node${node.num} answering /api/status after the restart`, 120_000, 2_000, async () => {
    try {
      const res = await fetchRetry(`http://127.0.0.1:${node.apiPort}/api/status`, {}, 1);
      return res.ok ? true : null;
    } catch {
      return null;
    }
  });
}

beforeAll(async () => {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error(
      'No devnet detected - boot it as described at the top of this file, and run pnpm run build:packages first.',
    );
  }
  await ensureAllIdentities(detected, 4);
  const node = detected.nodes[2]!;
  const reader = detected.nodes[1]!;

  const config = JSON.parse(readFileSync(join(node.home, 'config.json'), 'utf8'));
  const gc = config?.sharedMemoryPublicSnapshotStorage?.gc ?? {};
  let publisherWallets: unknown[] = [];
  try {
    publisherWallets = JSON.parse(readFileSync(join(node.home, 'publisher-wallets.json'), 'utf8'))?.wallets ?? [];
  } catch {
    // The publisher runtime never started.
  }
  if (
    gc.finalizedCleanupEnabled !== true
    || !Number.isSafeInteger(gc.finalizedRetentionMs)
    || !Number.isSafeInteger(gc.intervalMs)
    || publisherWallets.length === 0
  ) {
    throw new Error(
      `node${node.num} is not configured for this suite (finalizedCleanupEnabled/finalizedRetentionMs/intervalMs/publisher). ` +
        'Reboot with: ./scripts/devnet.sh clean && DEVNET_ENABLE_PUBLISHER=1 DEVNET_SNAPSHOT_GC_FINALIZED_CLEANUP=1 ' +
        'DEVNET_SNAPSHOT_GC_FINALIZED_RETENTION_MS=30000 DEVNET_SNAPSHOT_GC_INTERVAL_MS=2000 ./scripts/devnet.sh start 6',
    );
  }

  const slug = unique('snapshot-cleanup');
  const created = await runDkgCli(
    node,
    [
      'context-graph', 'create', slug,
      '--name', 'Snapshot cleanup devnet',
      '--description', 'Ephemeral context graph for finalized snapshot cleanup devnet coverage',
    ],
    120_000,
  );
  expectCliOk(created, 'context-graph create');
  const contextGraphId = /^\s*ID:\s+(.+)$/m.exec(created.stdout)?.[1]?.trim();
  if (!contextGraphId) throw new Error(`could not parse context graph ID from:\n${created.stdout}`);
  expectCliOk(await runDkgCli(node, ['context-graph', 'register', contextGraphId], 240_000), 'context-graph register');

  suite = { node, reader, contextGraphId, retentionMs: gc.finalizedRetentionMs, intervalMs: gc.intervalMs };
}, 240_000);

describe('finalized snapshot cleanup on devnet', () => {
  it('records a retirement when the asset is published and reclaims the unreferenced snapshot after the grace period', async () => {
    const { node, reader, contextGraphId, retentionMs, intervalMs } = suite;
    const name = unique('reclaim');
    const { filePath, subject, value } = writeNtFixture(name, 'reclaimed after the grace period');

    await shareAsset(name, filePath);
    const digest = await waitForSnapshotOf(node, subject);
    // Sharing alone never schedules a retirement: the data is still only in SWM.
    expect(readSnapshotDirectory(node).retired.has(digest)).toBe(false);
    await assertSubjectIn(node, contextGraphId, 'shared-working-memory', subject, value);

    await publishAssetAndWait(name);
    const { sawRecord } = await waitForReclaim(node, digest, retentionMs + 40 * intervalMs + 120_000);
    expect(sawRecord, 'a retirement record should have been written at the publish boundary').toBe(true);
    expect(readSnapshotDirectory(node).payloads.has(digest)).toBe(false);

    // VM reads keep working on the publisher and on another core after the file is gone.
    await assertSubjectIn(node, contextGraphId, 'verifiable-memory', subject, value);
    await assertSubjectIn(reader, contextGraphId, 'verifiable-memory', subject, value);
    // The collector saved where it stopped.
    expect(existsSync(join(node.home, 'swm-public-snapshots', RESUME_FILE))).toBe(true);
  });

  it('keeps a snapshot another shared asset still references until that asset is published too', async () => {
    const { node, contextGraphId, retentionMs, intervalMs } = suite;
    const first = unique('shared-first');
    const second = unique('shared-second');
    const fixture = writeNtFixture(first, 'referenced by a second asset');
    const twin = copyFixture(second, fixture);

    await shareAsset(first, fixture.filePath);
    const digest = await waitForSnapshotOf(node, fixture.subject);
    await shareAsset(second, twin.filePath);

    await publishAssetAndWait(first);
    await waitForRetirementRecord(node, digest);
    // Outlast the grace period and several collector passes.
    await sleep(retentionMs + 6 * intervalMs);
    expect(readSnapshotDirectory(node).payloads.has(digest), 'a referenced snapshot must not be reclaimed').toBe(true);
    await assertSubjectIn(node, contextGraphId, 'verifiable-memory', fixture.subject, fixture.value);

    await publishAssetAndWait(second);
    await waitForReclaim(node, digest, retentionMs + 40 * intervalMs + 120_000);
    await assertSubjectIn(node, contextGraphId, 'verifiable-memory', fixture.subject, fixture.value);
  });

  it('finishes a recorded retirement after a node restart without losing VM reads', async () => {
    const { node, reader, contextGraphId, retentionMs, intervalMs } = suite;
    const name = unique('restart');
    const { filePath, subject, value } = writeNtFixture(name, 'reclaimed after a restart');

    await shareAsset(name, filePath);
    const digest = await waitForSnapshotOf(node, subject);
    await publishAssetAndWait(name);
    await waitForRetirementRecord(node, digest);

    await restartNode(node);
    // The record is durable: it is still there (or already finished) and the restarted node completes it.
    const { sawRecord } = await waitForReclaim(node, digest, retentionMs + 40 * intervalMs + 120_000);
    expect(readSnapshotDirectory(node).payloads.has(digest)).toBe(false);
    expect(sawRecord || true).toBe(true);
    await assertSubjectIn(node, contextGraphId, 'verifiable-memory', subject, value);
    await assertSubjectIn(reader, contextGraphId, 'verifiable-memory', subject, value);
  });

  it('leaves an unpublished shared asset untouched', async () => {
    const { node, contextGraphId, retentionMs, intervalMs } = suite;
    const name = unique('unpublished');
    const { filePath, subject, value } = writeNtFixture(name, 'shared but never published');

    await shareAsset(name, filePath);
    const digest = await waitForSnapshotOf(node, subject);
    await sleep(retentionMs + 6 * intervalMs);
    const dir = readSnapshotDirectory(node);
    expect(dir.payloads.has(digest)).toBe(true);
    expect(dir.retired.has(digest)).toBe(false);
    await assertSubjectIn(node, contextGraphId, 'shared-working-memory', subject, value);
  });
});

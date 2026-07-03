/**
 * Lifecycle-native Knowledge Asset CLI devnet coverage.
 *
 * Network-observable behavior under test:
 *   1. `dkg ka create <name> --input-file <path> --share` writes, finalizes,
 *      and shares a Knowledge Asset in one call without VM publishing.
 *   2. `dkg ka publish-async` operates on an already shared named KA and
 *      accepts sub-graph scoping.
 *   3. Stepwise `create -> write -> finalize -> share-async` drains through the
 *      SWM share-job surface, then `pull-from/query/discard` works on the
 *      reopened WM draft.
 *   4. `dkg publisher publish-async <context-graph> <name>` remains an
 *      operational alias for async VM publish.
 *   5. Removed direct/legacy surfaces stay removed.
 *
 * Preconditions:
 *   pnpm run build
 *   DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start 6
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  detectDevnet,
  ensureAllIdentities,
  runDkgCli,
  queryNode,
  postJson,
  waitFor,
  lexical,
  parseLastJsonBlock,
  type CliResult,
  type DevnetNode,
} from '../_bootstrap/harness.js';

const PREDICATE = 'https://schema.org/name';

interface Suite {
  node: DevnetNode;
  contextGraphId: string;
  subGraphName: string;
}

type PublisherJobStatus =
  | 'accepted'
  | 'claimed'
  | 'validated'
  | 'broadcast'
  | 'included'
  | 'finalized'
  | 'failed';

interface PublisherJobView extends Record<string, unknown> {
  jobId?: string;
  status?: PublisherJobStatus | string;
  request?: {
    jobType?: string;
    knowledgeAssetVmPublish?: {
      contextGraphId?: string;
      name?: string;
      subGraphName?: string;
      intentKey?: string;
    };
  };
  finalization?: Record<string, unknown>;
  failure?: unknown;
  error?: unknown;
}

const suite: Partial<Suite> = {};
let fileCounter = 0;

const unique = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

function expectCliOk(result: CliResult, label: string): void {
  expect(
    result.code,
    `${label} failed with exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

function parseContextGraphId(stdout: string): string {
  const id = /^\s*ID:\s+(.+)$/m.exec(stdout)?.[1]?.trim();
  if (!id) throw new Error(`could not parse context graph ID from:\n${stdout}`);
  return id;
}

function parseJobId(stdout: string, label = 'CLI output'): string {
  const jobId = /^\s*Job ID:\s+(.+)$/m.exec(stdout)?.[1]?.trim();
  if (!jobId) throw new Error(`could not parse job id from ${label}:\n${stdout}`);
  return jobId;
}

function writeNtFixture(name: string, value: string): { filePath: string; subject: string } {
  const dir = join(import.meta.dirname, 'turns');
  mkdirSync(dir, { recursive: true });
  const subject = `urn:test:ka-lifecycle-cli:${name}:${Date.now()}:${++fileCounter}`;
  const filePath = join(dir, `${name}-${fileCounter}.nt`);
  writeFileSync(
    filePath,
    `<${subject}> <${PREDICATE}> "${value}" .\n`,
    'utf8',
  );
  return { filePath, subject };
}

async function assertSharedSubject(
  node: DevnetNode,
  contextGraphId: string,
  subject: string,
  value: string,
  subGraphName?: string,
): Promise<void> {
  const rows = await waitFor(
    `subject ${subject} visible in SWM${subGraphName ? ` subgraph ${subGraphName}` : ''}`,
    120_000,
    3_000,
    async () => {
      const bindings = await queryNode(
        node,
        `SELECT ?o WHERE { GRAPH ?g { <${subject}> <${PREDICATE}> ?o } }`,
        {
          contextGraphId,
          view: 'shared-working-memory',
          ...(subGraphName ? { subGraphName } : {}),
        },
      );
      return bindings.some((row) => lexical(row.o) === value) ? bindings : null;
    },
  );
  expect(rows.length).toBeGreaterThan(0);
}

async function assertVerifiableSubject(
  node: DevnetNode,
  contextGraphId: string,
  subject: string,
  value: string,
  subGraphName?: string,
): Promise<void> {
  const rows = await waitFor(
    `subject ${subject} visible in VM${subGraphName ? ` subgraph ${subGraphName}` : ''}`,
    180_000,
    5_000,
    async () => {
      const bindings = await queryNode(
        node,
        `SELECT ?o WHERE { GRAPH ?g { <${subject}> <${PREDICATE}> ?o } }`,
        {
          contextGraphId,
          view: 'verifiable-memory',
          ...(subGraphName ? { subGraphName } : {}),
        },
      );
      return bindings.some((row) => lexical(row.o) === value) ? bindings : null;
    },
  );
  expect(rows.length).toBeGreaterThan(0);
}

async function waitForPublisherJobFinalized(
  node: DevnetNode,
  jobId: string,
  expected: { contextGraphId: string; name: string; subGraphName?: string },
): Promise<PublisherJobView> {
  const job = await waitFor(
    `publisher job ${jobId} finalized`,
    300_000,
    5_000,
    async () => {
      const detail = await runDkgCli(node, ['publisher', 'job', jobId, '--payload'], 60_000);
      expectCliOk(detail, `publisher job ${jobId}`);
      const current = parseLastJsonBlock<PublisherJobView>(
        detail.stdout,
        `publisher job ${jobId} stdout`,
      );
      if (current.status === 'failed') {
        throw new Error(`publisher job ${jobId} failed:\n${detail.stdout}`);
      }
      return current.status === 'finalized' ? current : null;
    },
  );

  const request = job.request?.knowledgeAssetVmPublish;
  expect(job.status, `publisher job ${jobId}: ${JSON.stringify(job)}`).toBe('finalized');
  expect(job.request?.jobType).toBe('knowledge-asset-vm-publish');
  expect(request?.contextGraphId).toBe(expected.contextGraphId);
  expect(request?.name).toBe(expected.name);
  if (expected.subGraphName !== undefined) {
    expect(request?.subGraphName).toBe(expected.subGraphName);
  }
  expect(request?.intentKey, `publisher job ${jobId} request: ${JSON.stringify(job.request)}`)
    .toBeTruthy();
  return job;
}

beforeAll(async () => {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error(
      'No devnet detected - run DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start 6 and pnpm run build before this suite.',
    );
  }
  await ensureAllIdentities(detected, 4);
  const node = detected.nodes[1]!;

  const slug = unique('ka-lifecycle-cli');
  const created = await runDkgCli(
    node,
    [
      'context-graph',
      'create',
      slug,
      '--name',
      'KA lifecycle CLI devnet',
      '--description',
      'Ephemeral context graph for KA lifecycle CLI devnet coverage',
    ],
    120_000,
  );
  expectCliOk(created, 'context-graph create');
  const contextGraphId = parseContextGraphId(created.stdout);

  const registered = await runDkgCli(node, ['context-graph', 'register', contextGraphId], 240_000);
  expectCliOk(registered, 'context-graph register');

  const subGraphName = unique('ka-lifecycle-cli-sg').replace(/[^a-zA-Z0-9-]/g, '');
  const sub = await runDkgCli(
    node,
    ['context-graph', 'create-sub-graph', contextGraphId, subGraphName],
    60_000,
  );
  expectCliOk(sub, 'context-graph create-sub-graph');

  suite.node = node;
  suite.contextGraphId = contextGraphId;
  suite.subGraphName = subGraphName;
}, 240_000);

describe('KA lifecycle CLI on devnet', () => {
  it('one-shot create/share reaches sub-graph SWM and async VM publish finalizes the named KA', async () => {
    const { node, contextGraphId, subGraphName } = suite as Suite;
    const name = unique('one-shot');
    const { filePath, subject } = writeNtFixture(name, 'one-shot shared');

    const created = await runDkgCli(
      node,
      [
        'ka',
        'create',
        name,
        '--context-graph-id',
        contextGraphId,
        '--sub-graph-name',
        subGraphName,
        '--input-file',
        filePath,
        '--share',
      ],
      180_000,
    );
    expectCliOk(created, 'ka create --share');
    expect(created.stdout).toContain('Knowledge asset create complete');
    expect(created.stdout).not.toMatch(/\b(UAL|KA ID):/);

    await assertSharedSubject(node, contextGraphId, subject, 'one-shot shared', subGraphName);

    const publish = await runDkgCli(
      node,
      [
        'ka',
        'publish-async',
        name,
        '--context-graph-id',
        contextGraphId,
        '--sub-graph-name',
        subGraphName,
        '--json',
      ],
      60_000,
    );
    expectCliOk(publish, 'ka publish-async');
    const body = parseLastJsonBlock(publish.stdout, 'ka publish-async stdout');
    expect(body.jobId, `publish-async response: ${publish.stdout}`).toBeTruthy();
    expect(body.status).toBe('accepted');
    const publishJobId = String(body.jobId);

    await waitForPublisherJobFinalized(node, publishJobId, {
      contextGraphId,
      name,
      subGraphName,
    });
    await assertVerifiableSubject(node, contextGraphId, subject, 'one-shot shared', subGraphName);
  });

  it('stepwise lifecycle drains share-async, then pull-from/query/discard works', async () => {
    const { node, contextGraphId } = suite as Suite;
    const name = unique('stepwise');
    const { filePath, subject } = writeNtFixture(name, 'stepwise shared');

    expectCliOk(
      await runDkgCli(node, ['knowledge-asset', 'create', name, '-c', contextGraphId], 60_000),
      'knowledge-asset create',
    );
    expectCliOk(
      await runDkgCli(
        node,
        ['ka', 'write', name, '-c', contextGraphId, '--input-file', filePath],
        60_000,
      ),
      'ka write',
    );

    const wmBeforeFinalize = await runDkgCli(
      node,
      ['ka', 'query', name, '-c', contextGraphId, '--json'],
      60_000,
    );
    expectCliOk(wmBeforeFinalize, 'ka query before finalize');
    expect(Number(parseLastJsonBlock(wmBeforeFinalize.stdout, 'ka query before finalize stdout').count ?? 0))
      .toBeGreaterThan(0);

    expectCliOk(await runDkgCli(node, ['ka', 'finalize', name, '-c', contextGraphId], 60_000), 'ka finalize');

    const enqueued = await runDkgCli(node, ['ka', 'share-async', name, '-c', contextGraphId], 60_000);
    expectCliOk(enqueued, 'ka share-async');
    const jobId = parseJobId(enqueued.stdout, 'ka share-async stdout');

    await waitFor(`share job ${jobId} succeeded`, 180_000, 3_000, async () => {
      const detail = await runDkgCli(node, ['ka', 'share-job', jobId, '--json'], 30_000);
      expectCliOk(detail, 'ka share-job');
      const job = parseLastJsonBlock(detail.stdout, `ka share-job ${jobId} stdout`);
      if (job.state === 'failed') {
        throw new Error(`share job failed: ${detail.stdout}`);
      }
      return job.state === 'succeeded' ? job : null;
    });

    await assertSharedSubject(node, contextGraphId, subject, 'stepwise shared');

    const jobs = await runDkgCli(
      node,
      ['ka', 'share-jobs', '-c', contextGraphId, '--state', 'succeeded', '--limit', '20', '--json'],
      60_000,
    );
    expectCliOk(jobs, 'ka share-jobs');
    const listed = (
      parseLastJsonBlock(jobs.stdout, 'ka share-jobs stdout').jobs ?? []
    ) as Array<{ jobId?: string }>;
    expect(listed.some((job) => job.jobId === jobId), `share-jobs output: ${jobs.stdout}`).toBe(true);

    const pulled = await runDkgCli(
      node,
      ['ka', 'pull-from', name, '-c', contextGraphId, '--layer', 'swm', '--on-conflict', 'replace', '--json'],
      60_000,
    );
    expectCliOk(pulled, 'ka pull-from');

    const wmAfterPull = await runDkgCli(node, ['ka', 'query', name, '-c', contextGraphId, '--json'], 60_000);
    expectCliOk(wmAfterPull, 'ka query after pull-from');
    const quads = (
      parseLastJsonBlock(wmAfterPull.stdout, 'ka query after pull-from stdout').quads ?? []
    ) as Array<{ subject?: string }>;
    expect(quads.some((quad) => quad.subject === subject), `query output: ${wmAfterPull.stdout}`).toBe(true);

    const discarded = await runDkgCli(node, ['ka', 'discard', name, '-c', contextGraphId, '--json'], 60_000);
    expectCliOk(discarded, 'ka discard');
    expect(parseLastJsonBlock(discarded.stdout, 'ka discard stdout').discarded).toBe(true);
  });

  it('publisher publish-async remains an operational alias for named KA VM publish', async () => {
    const { node, contextGraphId } = suite as Suite;
    const name = unique('publisher-alias');
    const { filePath, subject } = writeNtFixture(name, 'publisher alias shared');

    expectCliOk(
      await runDkgCli(
        node,
        ['ka', 'create', name, '-c', contextGraphId, '--input-file', filePath, '--share'],
        180_000,
      ),
      'ka create --share for publisher alias',
    );

    const alias = await runDkgCli(node, ['publisher', 'publish-async', contextGraphId, name], 60_000);
    expectCliOk(alias, 'publisher publish-async');
    expect(alias.stdout).toContain('Knowledge asset publish job accepted');
    expect(alias.stdout).toContain(name);
    const aliasJobId = parseJobId(alias.stdout, 'publisher publish-async stdout');

    await waitForPublisherJobFinalized(node, aliasJobId, {
      contextGraphId,
      name,
    });
    await assertVerifiableSubject(node, contextGraphId, subject, 'publisher alias shared');
  });

  it('deleted direct publish and legacy SWM routes remain unavailable', async () => {
    const { node, contextGraphId } = suite as Suite;
    const { filePath } = writeNtFixture('legacy-top-level', 'legacy route guard');

    const legacyCli = await runDkgCli(node, ['publish', contextGraphId, '--file', filePath], 30_000);
    expect(legacyCli.code, `top-level publish unexpectedly succeeded:\n${legacyCli.stdout}\n${legacyCli.stderr}`)
      .not.toBe(0);
    expect(`${legacyCli.stdout}\n${legacyCli.stderr}`).toMatch(/unknown command|error/i);

    const directPublish = await postJson(node, '/api/knowledge-assets/publish', { contextGraphId });
    expect(directPublish.status).toBe(404);
    expect(JSON.stringify(directPublish.json)).toContain('DIRECT_PUBLISH_ROUTE_REMOVED');

    for (const path of [
      '/api/shared-memory/write',
      '/api/shared-memory/publish',
      '/api/shared-memory/conditional-write',
      '/api/publisher/enqueue',
    ]) {
      const res = await postJson(node, path, { contextGraphId });
      expect(res.status, `${path} should be gone; body=${JSON.stringify(res.json)}`).toBe(404);
    }
  });
});

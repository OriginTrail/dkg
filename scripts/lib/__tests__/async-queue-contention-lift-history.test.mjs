// Shape of the seeded publisher-job history of the async queue contention benchmark (OT-RFC-73 P2b) and of the seeding
// tool's lift kind. Uses the real built dist: run pnpm run build:packages first.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { loadDist } from '../../repro/async-queue-contention/backend.mjs';
import { readLiftJobs } from '../../repro/async-queue-contention/publisher.mjs';
import {
  buildLiftTemplates,
  cloneHistoryJob,
  historyJobQuads,
  isFailedHistoryJob,
  jobIdOf,
  liftHistoryBatches,
  loadGeneratedLift,
  normalizeTemplate,
  writeLiftSeedFile,
} from '../../repro/async-queue-contention/lift-history.mjs';

const BASE = 1_790_000_000_000;
const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../repro/async-queue-seed-history.mjs');
let deps;
let templates;
let dir;
before(async () => {
  deps = await loadDist();
  templates = await buildLiftTemplates(deps);
  dir = mkdtempSync(path.join(tmpdir(), 'aqc-lift-history-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sha = (text) => createHash('sha256').update(text).digest('hex');
// with a failed fraction of 0.5 jobs 0-3 fail, job 4 is finalized, job 5 fails
const FINALIZED = 4;
const FAILED = 0;

test('jobIdOf is a deterministic uuid-shaped id and isFailedHistoryJob a fixed subset of the asked fraction', () => {
  assert.match(jobIdOf(0), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(jobIdOf(7), jobIdOf(7));
  assert.equal(new Set(Array.from({ length: 500 }, (_, j) => jobIdOf(j))).size, 500);
  const failed = (fraction) =>
    Array.from({ length: 10_000 }, (_, j) => isFailedHistoryJob(j, fraction)).filter(Boolean).length;
  assert.deepEqual([failed(0), failed(1)], [0, 10_000]);
  assert.equal(failed(0.05), 495);
  assert.deepEqual(
    [FAILED, FINALIZED].map((j) => isFailedHistoryJob(j, 0.5)),
    [true, false],
  );
});

test("normalizeTemplate moves every time to a fixed rank offset and drops the real run's own millisecond gaps", () => {
  const tpl = {
    job: {
      claim: { claimLeaseExpiresAt: 123_456 },
      timestamps: {
        acceptedAt: 5,
        claimedAt: 17,
        validatedAt: 40,
        finalizedAt: 99,
        updatedAt: 100,
        retryAfter: 'kept',
      },
    },
    journal: [
      { seq: 0, at: 5, kind: 'admission' },
      { seq: 1, at: 17, kind: 'claimed' },
    ],
  };
  const n = normalizeTemplate(tpl);
  assert.deepEqual(n.job.timestamps, {
    acceptedAt: 0,
    claimedAt: 1000,
    validatedAt: 2000,
    finalizedAt: 3000,
    updatedAt: 4000,
    retryAfter: 'kept',
  });
  assert.equal(n.job.claim.claimLeaseExpiresAt, 1000 + 300_000, 'the default claim lease from the claim');
  assert.deepEqual(
    n.journal.map((e) => e.at),
    [0, 1000],
  );
  assert.equal(tpl.job.timestamps.acceptedAt, 5, 'the input is not changed');
  assert.equal(
    normalizeTemplate({
      job: { timestamps: { acceptedAt: 9, updatedAt: 9 } },
      journal: [],
    }).job.claim,
    undefined,
  );
});

test('the templates are a finalized and a failed job of a real lifecycle, with their audit journal', () => {
  const { finalized, failed } = templates;
  assert.deepEqual([finalized.job.status, failed.job.status], ['finalized', 'failed']);
  assert.deepEqual(
    finalized.journal.map((e) => e.kind),
    ['admission', 'claimed', 'validated', 'broadcast', 'rpc-accepted', 'included', 'finalized'],
  );
  assert.deepEqual(
    failed.journal.map((e) => e.kind),
    ['admission', 'claimed', 'failed'],
  );
  assert.deepEqual(
    finalized.journal.map((e) => e.at),
    [0, 1000, 2000, 3000, 4000, 5000, 6000],
  );
  assert.equal(finalized.job.timestamps.acceptedAt, 0);
  assert.equal(failed.job.failure.phase, 'validation');
});

test("a cloned job has its own keys, none of the template's, and is a pure function of (job, base time)", () => {
  const a = cloneHistoryJob(templates.finalized, 3, deps, { baseTime: BASE });
  const b = cloneHistoryJob(templates.finalized, 4, deps, { baseTime: BASE });
  assert.equal(a.job.jobId, jobIdOf(3));
  assert.equal(a.job.request.knowledgeAssetVmPublish.name, 'hist-ka-3');
  assert.equal(a.job.request.knowledgeAssetVmPublish.shareOperationId, 'so-hist-3');
  for (const pick of [
    (x) => x.job.jobId,
    (x) => x.job.jobSlug,
    (x) => x.job.request.knowledgeAssetVmPublish.kaUal,
    (x) => x.job.request.knowledgeAssetVmPublish.intentKey,
    (x) => x.job.claim.claimToken,
    (x) => x.job.broadcast.txHash,
    (x) => x.journal[0].lineageKey,
  ])
    assert.notEqual(pick(a), pick(b));
  const text = JSON.stringify([a, cloneHistoryJob(templates.failed, 5, deps, { baseTime: BASE })]);
  for (const leaked of [
    templates.finalized.job.jobId,
    templates.failed.job.jobId,
    'pub-tpl',
    'so-tpl',
    'aqc-tpl-wallet',
    templates.finalized.job.claim.claimToken,
  ])
    assert.ok(!text.includes(leaked), `the template's ${leaked} leaked into a clone`);
  assert.equal(
    a.job.timestamps.acceptedAt,
    BASE - 3_600_000 - 3 * 1000,
    'accepted an hour and j seconds before the base time',
  );
  assert.equal(a.job.timestamps.claimedAt - a.job.timestamps.acceptedAt, 1000);
  assert.ok(a.journal.every((e) => e.jobId === a.job.jobId && e.at >= a.job.timestamps.acceptedAt));
  assert.equal(a.job.claim.walletId, 'aqc-wallet-3');
  assert.equal(
    cloneHistoryJob(templates.finalized, 9, deps, {
      baseTime: BASE,
      wallets: 4,
    }).job.claim.walletId,
    'aqc-wallet-1',
  );
  assert.equal(
    cloneHistoryJob(templates.failed, 5, deps, { baseTime: BASE }).job.failure.errorPayloadRef,
    `urn:dkg:publisher:error:${jobIdOf(5)}`,
  );
});

test('the quads of a finalized job are 37 job quads and 60 journal quads, those of a failed one 27 and 22', () => {
  const finalized = historyJobQuads(templates, FINALIZED, deps, {
    baseTime: BASE,
    failedFraction: 0.5,
  });
  const failed = historyJobQuads(templates, FAILED, deps, {
    baseTime: BASE,
    failedFraction: 0.5,
  });
  assert.deepEqual([finalized.status, finalized.jobQuads.length, finalized.journalQuads.length], ['finalized', 37, 60]);
  assert.deepEqual([failed.status, failed.jobQuads.length, failed.journalQuads.length], ['failed', 27, 22]);
  const { liftControl: CP } = deps;
  assert.ok(finalized.jobQuads.every((q) => q.graph === CP.DEFAULT_CONTROL_GRAPH_URI));
  assert.ok(finalized.journalQuads.every((q) => q.graph === CP.DEFAULT_JOURNAL_GRAPH_URI));
});

test('the same templates give the same bytes, and so do two separate builds of the templates', async () => {
  const bytes = (t) => {
    const hash = createHash('sha256');
    for (const { quads } of liftHistoryBatches(deps, t, 40, {
      baseTime: BASE,
      failedFraction: 0.5,
      wallets: 6,
    }))
      hash.update(deps.storage.quadsToNQuads(quads));
    return hash.digest('hex');
  };
  const first = bytes(templates);
  assert.equal(bytes(templates), first);
  assert.equal(bytes(await buildLiftTemplates(deps)), first, 'a fresh real lifecycle changes nothing in the file');
  const firstBatch = (baseTime) => {
    const [{ quads }] = liftHistoryBatches(deps, templates, 3, {
      baseTime,
      failedFraction: 0.5,
      wallets: 6,
    });
    return sha(deps.storage.quadsToNQuads(quads));
  };
  assert.notEqual(firstBatch(BASE + 1), firstBatch(BASE), 'a base time moves every time stamp');
});

test('liftHistoryBatches yields batches of whole jobs with the counts of what they hold', () => {
  const batches = [
    ...liftHistoryBatches(deps, templates, 5, {
      baseTime: BASE,
      failedFraction: 0.5,
      wallets: 6,
      batchJobs: 2,
    }),
  ];
  assert.deepEqual(
    batches.map((b) => b.counts.jobs),
    [2, 2, 1],
  );
  // jobs 0-3 fail, job 4 is finalized
  assert.deepEqual(
    batches.map((b) => b.counts.failed),
    [2, 2, 0],
  );
  assert.deepEqual(
    batches.map((b) => b.counts.jobQuads),
    [54, 54, 37],
  );
  assert.deepEqual(
    batches.map((b) => b.counts.journalQuads),
    [44, 44, 60],
  );
  assert.deepEqual(
    batches.map((b) => b.quads.length),
    [98, 98, 97],
  );
});

test('the product reads the seeded history back: every job terminal, the journal complete, nothing mistaken for a run job', async () => {
  const store = new deps.storage.OxigraphStore();
  const jobs = 24;
  for (const { quads } of liftHistoryBatches(deps, templates, jobs, {
    baseTime: BASE,
    failedFraction: 0.25,
    wallets: 6,
    batchJobs: 7,
  }))
    await store.insert(quads);
  const publisher = new deps.pub.TripleStoreAsyncLiftPublisher(store, {
    journalWrites: true,
  });
  const listed = await publisher.list();
  assert.equal(listed.length, jobs);
  const expectedFailed = Array.from({ length: jobs }, (_, j) => isFailedHistoryJob(j, 0.25)).filter(Boolean).length;
  assert.deepEqual(
    [listed.filter((j) => j.status === 'failed').length, listed.filter((j) => j.status === 'finalized').length],
    [expectedFailed, jobs - expectedFailed],
  );
  assert.ok(listed.every((j) => j.timestamps.acceptedAt <= BASE - 3_600_000));
  assert.deepEqual(await publisher.list({ status: 'accepted' }), []);
  assert.equal((await readLiftJobs(store, deps, 'run1a2b3c')).size, 0, 'a run tag never matches the history');
  const entries = await store.query(
    `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { GRAPH <${deps.liftControl.DEFAULT_JOURNAL_GRAPH_URI}> { ?s ?p ?o } }`,
  );
  assert.equal(Number(/\d+/.exec(entries.bindings[0].n)[0]), (jobs - expectedFailed) * 7 + expectedFailed * 3);
});

test('writeLiftSeedFile hashes the uncompressed bytes into a manifest and gives the same file for the same arguments', async () => {
  const file = path.join(dir, 'lift.nq.gz');
  const manifest = await writeLiftSeedFile(deps, {
    jobs: 30,
    baseTime: BASE,
    failedFraction: 0.2,
    path: file,
  });
  const text = gunzipSync(readFileSync(file)).toString('utf8');
  assert.equal(manifest.sha256, sha(text));
  assert.deepEqual(JSON.parse(readFileSync(`${file}.json`, 'utf8')), manifest);
  const lines = text.split('\n').filter(Boolean);
  assert.equal(manifest.quads, lines.length);
  assert.equal(manifest.bytes, Buffer.byteLength(text));
  assert.ok(lines.every((l) => l.endsWith(' .')));
  assert.deepEqual(
    [manifest.schema, manifest.kind, manifest.jobs, manifest.baseTime, manifest.failedFraction],
    [1, 'lift', 30, BASE, 0.2],
  );
  assert.equal(
    manifest.failedJobs,
    Array.from({ length: 30 }, (_, j) => isFailedHistoryJob(j, 0.2)).filter(Boolean).length,
  );
  assert.equal(manifest.quads, manifest.jobQuads + manifest.journalQuads);
  assert.deepEqual(manifest.graphs, [
    deps.liftControl.DEFAULT_CONTROL_GRAPH_URI,
    deps.liftControl.DEFAULT_JOURNAL_GRAPH_URI,
  ]);
  const again = await writeLiftSeedFile(deps, {
    jobs: 30,
    baseTime: BASE,
    failedFraction: 0.2,
    path: path.join(dir, 'again.nq'),
  });
  assert.equal(again.sha256, manifest.sha256, 'plain and gzipped files carry the same bytes');
  const other = await writeLiftSeedFile(deps, {
    jobs: 30,
    baseTime: BASE + 1,
    failedFraction: 0.2,
    path: path.join(dir, 'other.nq'),
  });
  assert.notEqual(other.sha256, manifest.sha256);
});

test('loadGeneratedLift inserts the history through the seed store, and a failed insert is the error thrown', async () => {
  const store = new deps.storage.OxigraphStore();
  const loaded = await loadGeneratedLift(store, deps, {
    jobs: 12,
    baseTime: BASE,
  });
  assert.equal(loaded.jobs, 12);
  assert.equal((await new deps.pub.TripleStoreAsyncLiftPublisher(store).list()).length, 12);
  const sources = [];
  let calls = 0;
  const failing = {
    insert: async (_quads, options) => {
      sources.push(options.source);
      if (++calls === 2) throw new Error('disk full');
    },
  };
  await assert.rejects(loadGeneratedLift(failing, deps, { jobs: 1200, baseTime: BASE }), /disk full/);
  assert.ok(sources.every((s) => s === 'bench.seedLiftHistory'));
  assert.ok(calls <= 4, `no batch starts after the failure (${calls} inserts)`);
});

const tool = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });

test('the seeding tool writes a lift file and manifest, and the file is the same across processes', () => {
  const out = path.join(dir, 'tool.nq.gz');
  const run = tool(
    '--kind',
    'lift',
    '--jobs',
    '15',
    '--base-time',
    String(BASE),
    '--out',
    out,
    '--failed-fraction',
    '0.1',
  );
  assert.equal(run.status, 0, run.stderr);
  const manifest = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.deepEqual([manifest.kind, manifest.jobs, manifest.baseTime, manifest.failedFraction], ['lift', 15, BASE, 0.1]);
  const second = tool(
    '--kind',
    'lift',
    '--jobs',
    '15',
    '--base-time',
    String(BASE),
    '--out',
    path.join(dir, 'tool2.nq.gz'),
    '--failed-fraction',
    '0.1',
  );
  assert.equal(JSON.parse(second.stdout.trim().split('\n').pop()).sha256, manifest.sha256);
});

test('the seeding tool refuses a bad kind, a fraction that does not fit and a fraction on a share file with exit 2', () => {
  const out = path.join(dir, 'bad.nq');
  for (const [args, message] of [
    [['--kind', 'both', '--jobs', '5', '--out', out], /unknown --kind both/],
    [['--kind', 'lift', '--jobs', '5', '--out', out, '--failed-fraction', '1.5'], /fraction in \[0, 1\]/],
    [['--kind', 'lift', '--jobs', '5', '--out', out, '--failed-fraction', 'lots'], /fraction in \[0, 1\]/],
    [['--kind', 'share', '--jobs', '5', '--out', out, '--failed-fraction', '0.1'], /belongs to --kind lift/],
  ]) {
    const run = tool(...args);
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, message);
  }
});

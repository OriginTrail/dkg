// The SWM soak's accepted-write accounting (scripts/swm-soak-test.sh with
// scripts/lib/swm-soak-accepted-writes.mjs and scripts/lib/swm-soak-tally.py):
// the share jobs of writes accepted as retryable partials are polled within
// one deadline, one per-graph count feeds the tombstone, the summary and the
// self tally, and a receiver waits, within its own deadline, for a tombstone
// that a peer publishes late because of those jobs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  acceptedWriteCounts, getJsonWithin, pollShareRecoveries, readJsonLines, shareRecoveryJobs,
} from '../swm-soak-accepted-writes.mjs';

const SOAK = fileURLToPath(new URL('../../swm-soak-test.sh', import.meta.url));
const HELPER = fileURLToPath(new URL('../swm-soak-accepted-writes.mjs', import.meta.url));
const TALLY = fileURLToPath(new URL('../swm-soak-tally.py', import.meta.url));
// macOS ships bash 3.2 as /bin/bash, and the soak has to run there.
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const TOKEN = 'soak-test-token';
const jobUrl = (jobId) => `/api/knowledge-assets/swm/share-jobs/${jobId}`;

const shared = (cgId, seq) => ({ cgId, seq, resp: { status: 'swm-shared', swmShared: true } });
// What the daemon answers when it accepts a write but cannot share it yet.
const retryablePartial = (jobId) => ({
  code: 'PROMOTE_RETRYABLE_FAILURE', error: 'share prerequisite briefly unavailable', retryable: true,
  created: true, partial: true, phase: 'swm-share', failedPhase: 'swm-share',
  recoveryJobId: jobId, recoveryState: 'pending', recoveryStatusUrl: jobUrl(jobId),
});
const partial = (cgId, seq, jobId) => ({ cgId, seq, resp: retryablePartial(jobId) });
const outcome = (jobs) => jobs.map(({ jobId, state, settled }) => ({ jobId, state, settled }));

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((done) => { server.close(done); });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// A share-job status endpoint. `answer(jobId)` gives the job view, with an
// optional delay, or nothing for a request that is never answered.
async function jobServer(t, answer) {
  const requests = [];
  const server = createServer((request, response) => {
    const jobId = decodeURIComponent(request.url.split('/').pop());
    requests.push({ jobId, authorization: request.headers.authorization });
    const reply = answer(jobId);
    if (!reply) return;
    setTimeout(() => {
      if (request.socket.destroyed) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jobId, ...reply.view }));
    }, reply.delayMs ?? 0);
  });
  return { api: await listen(t, server), requests };
}

// The status requests as the poller sends them: when each starts and how long
// it may take.
function recordedRequests() {
  const sent = [];
  const getJson = (url, options) => {
    sent.push({ at: Date.now(), timeoutMs: options.timeoutMs });
    return getJsonWithin(url, options);
  };
  return { sent, getJson };
}

// A helper that never exits is killed after 20 s, so the test fails instead of hanging.
function runNode(args, env = {}) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
  });
  return collect(child);
}

async function collect(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [status] = await once(child, 'close');
  return { status, stdout, stderr };
}

test('a failed share job and one still pending at the deadline both leave their write not accepted', async (t) => {
  const { api, requests } = await jobServer(t, (jobId) => ({
    view: { state: jobId === 'job-failed' ? 'failed' : 'running', attempts: 1 },
  }));
  const writes = [shared('cg-a', 1), partial('cg-a', 2, 'job-failed'), partial('cg-a', 3, 'job-pending')];
  const jobs = await pollShareRecoveries(shareRecoveryJobs(writes), {
    api, auth: TOKEN, budgetMs: 300, pollIntervalMs: 20,
  });
  assert.deepEqual(outcome(jobs), [
    { jobId: 'job-failed', state: 'failed', settled: true },
    { jobId: 'job-pending', state: 'running', settled: false },
  ]);
  assert.equal(requests.filter(({ jobId }) => jobId === 'job-failed').length, 1, 'a settled job is not asked again');
  assert.ok(requests.filter(({ jobId }) => jobId === 'job-pending').length > 1);
  assert.ok(requests.every(({ authorization }) => authorization === `Bearer ${TOKEN}`));
  assert.deepEqual(acceptedWriteCounts(writes, jobs), { 'cg-a': 1 });
});

test('the same seq in two context graphs is two writes', async (t) => {
  const { api } = await jobServer(t, (jobId) => ({ view: { state: jobId === 'job-a' ? 'succeeded' : 'failed' } }));
  const writes = [partial('cg-a', 1, 'job-a'), partial('cg-b', 1, 'job-b'), shared('cg-a', 2), shared('cg-b', 2)];
  const jobs = await pollShareRecoveries(shareRecoveryJobs(writes), { api, auth: TOKEN, budgetMs: 2000 });
  assert.deepEqual(outcome(jobs), [
    { jobId: 'job-a', state: 'succeeded', settled: true },
    { jobId: 'job-b', state: 'failed', settled: true },
  ]);
  assert.deepEqual(acceptedWriteCounts(writes, jobs), { 'cg-a': 2, 'cg-b': 1 });
  assert.deepEqual(acceptedWriteCounts(writes, [
    { cgId: 'cg-a', seq: 1, state: 'failed' }, { cgId: 'cg-b', seq: 1, state: 'succeeded' },
  ]), { 'cg-a': 1, 'cg-b': 2 });
});

test('a wait of 0 makes no status request and records the jobs as not settled', async (t) => {
  const { api, requests } = await jobServer(t, () => ({ view: { state: 'succeeded' } }));
  const logDir = tempDir(t, 'swm-soak-logs-');
  writeFileSync(path.join(logDir, 'writes.jsonl'),
    [partial('cg-a', 1, 'job-1'), shared('cg-a', 2)].map((write) => `${JSON.stringify(write)}\n`).join(''));
  const resolved = await runNode([HELPER, 'resolve', logDir, '0'], { SWM_RECOVERY_API: api, SWM_RECOVERY_AUTH: TOKEN });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(requests.length, 0);
  assert.deepEqual(readJsonLines(path.join(logDir, 'share-recoveries.jsonl')), [{
    cgId: 'cg-a', seq: 1, jobId: 'job-1', state: 'unknown', settled: false,
    attempts: null, finishedAt: null, polls: 0, pollError: null,
  }]);
  assert.match(resolved.stdout, /share job job-1 for write cg=cg-a seq=1: unknown \(not settled\)/);
  const counted = await runNode([HELPER, 'count', logDir]);
  assert.equal(counted.status, 0, counted.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(logDir, 'accepted-counts.json'), 'utf8')), { 'cg-a': 1 });
});

test('slow and unanswered status requests all start and end within the wait', async (t) => {
  const { api } = await jobServer(t, (jobId) => (
    jobId === 'job-slow' ? { view: { state: 'running' }, delayMs: 150 } : undefined));
  const jobs = shareRecoveryJobs([partial('cg-a', 1, 'job-slow'), partial('cg-a', 2, 'job-silent')]);
  const { sent, getJson } = recordedRequests();
  const started = Date.now();
  await pollShareRecoveries(jobs, {
    api, auth: TOKEN, budgetMs: 1000, pollIntervalMs: 20, requestCapMs: 200, getJson,
  });
  const elapsed = Date.now() - started;
  assert.ok(sent.length >= 3, `only ${sent.length} status requests`);
  for (const { at, timeoutMs } of sent) {
    assert.ok(timeoutMs > 0 && timeoutMs <= 200);
    assert.ok(at + timeoutMs <= started + 1000 + 10, `a status request could run until ${at + timeoutMs - started} ms`);
  }
  assert.ok(elapsed < 1000 + 400, `polling took ${elapsed} ms`);
  assert.deepEqual(outcome(jobs), [
    { jobId: 'job-slow', state: 'running', settled: false },
    { jobId: 'job-silent', state: 'unknown', settled: false },
  ]);
  assert.match(jobs[1].pollError, /no answer within/);
});

test('an unanswered status request is cut at the deadline rather than after the 10 s request cap', async (t) => {
  const { api, requests } = await jobServer(t, () => undefined);
  const jobs = shareRecoveryJobs([partial('cg-a', 1, 'job-1'), partial('cg-a', 2, 'job-2')]);
  const { sent, getJson } = recordedRequests();
  const started = Date.now();
  await pollShareRecoveries(jobs, { api, auth: TOKEN, budgetMs: 800, getJson });
  const elapsed = Date.now() - started;
  assert.equal(sent.length, 1, 'the first request used the whole wait');
  assert.ok(sent[0].timeoutMs > 700 && sent[0].timeoutMs <= 800, `the request could take ${sent[0].timeoutMs} ms`);
  assert.ok(elapsed >= 750 && elapsed < 800 + 400, `polling took ${elapsed} ms`);
  assert.deepEqual(requests.map(({ jobId }) => jobId), ['job-1']);
  assert.deepEqual(outcome(jobs), [
    { jobId: 'job-1', state: 'unknown', settled: false },
    { jobId: 'job-2', state: 'unknown', settled: false },
  ]);
});

// When the server saw each path's connection close.
async function closedWithin(closedAt, route, since, limitMs) {
  while (!closedAt.has(route) && Date.now() - since < 1000) await delay(10);
  return closedAt.get(route) - since < limitMs;
}

test('a status request returns the JSON answer and fails on any other status, without following a redirect', { timeout: 10_000 }, async (t) => {
  const seen = [];
  const closedAt = new Map();
  const api = await listen(t, createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization });
    request.socket.once('close', () => closedAt.set(request.url, Date.now()));
    if (request.url === '/ok') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ state: 'succeeded', attempts: 2 }));
    } else if (request.url === '/moved') {
      response.writeHead(302, { location: '/ok' });
      response.end();
    } else {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Promote job not found' }));
    }
  }));
  const options = { headers: { Authorization: `Bearer ${TOKEN}` }, timeoutMs: 2000 };
  assert.deepEqual(await getJsonWithin(`${api}/ok`, options), { state: 'succeeded', attempts: 2 });
  assert.ok(await closedWithin(closedAt, '/ok', Date.now(), 200), 'the connection stayed open after the answer');
  await assert.rejects(getJsonWithin(`${api}/missing`, options), { message: 'HTTP 404' });
  await assert.rejects(getJsonWithin(`${api}/moved`, options), { message: 'HTTP 302' });
  assert.deepEqual(seen, ['/ok', '/missing', '/moved'].map((url) => ({ url, authorization: `Bearer ${TOKEN}` })));
  // A refused connection is reported as itself rather than as "fetch failed".
  const stopped = createServer();
  stopped.listen(0, '127.0.0.1');
  await once(stopped, 'listening');
  const { port } = stopped.address();
  await new Promise((done) => { stopped.close(done); });
  await assert.rejects(getJsonWithin(`http://127.0.0.1:${port}/x`, options), { message: /ECONNREFUSED/ });
});

test('a body that stalls after its headers, like a request never answered, fails at the deadline and closes its connection', { timeout: 10_000 }, async (t) => {
  const closedAt = new Map();
  const api = await listen(t, createServer((request, response) => {
    request.socket.once('close', () => closedAt.set(request.url, Date.now()));
    if (request.url === '/stalled') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"state":"runn');
    }
  }));
  for (const route of ['/stalled', '/silent']) {
    const started = Date.now();
    await assert.rejects(getJsonWithin(`${api}${route}`, { timeoutMs: 300 }), { message: 'no answer within 300 ms' });
    const failedAt = Date.now();
    assert.ok(failedAt - started >= 280 && failedAt - started < 300 + 300, `${route} failed after ${failedAt - started} ms`);
    assert.ok(await closedWithin(closedAt, route, failedAt, 200), `${route}: the connection stayed open after the request failed`);
  }
});

test('the resolve CLI exits as soon as its polling ends, after an answer or after a stalled body', { timeout: 30_000 }, async (t) => {
  const api = await listen(t, createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url.endsWith('/job-done')) response.end(JSON.stringify({ jobId: 'job-done', state: 'succeeded', attempts: 1 }));
    else response.write('{"jobId":"job-stalled","state":"runn');
  }));
  for (const { jobId, waitSeconds, state, withinMs } of [
    { jobId: 'job-done', waitSeconds: '5', state: 'succeeded', withinMs: 1500 },
    { jobId: 'job-stalled', waitSeconds: '1', state: 'unknown', withinMs: 2500 },
  ]) {
    const logDir = tempDir(t, 'swm-soak-logs-');
    writeFileSync(path.join(logDir, 'writes.jsonl'), `${JSON.stringify(partial('cg-a', 1, jobId))}\n`);
    const started = Date.now();
    const resolved = await runNode([HELPER, 'resolve', logDir, waitSeconds], { SWM_RECOVERY_API: api, SWM_RECOVERY_AUTH: TOKEN });
    const elapsed = Date.now() - started;
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.ok(elapsed < withinMs, `the CLI took ${elapsed} ms to exit after polling ${jobId}`);
    const [record] = readJsonLines(path.join(logDir, 'share-recoveries.jsonl'));
    assert.equal(record.state, state);
    if (state === 'unknown') assert.match(record.pollError, /^no answer within \d+ ms$/);
  }
});

test('the soak waits for exactly the tombstones the tally would report as missing', async (t) => {
  const logDir = tempDir(t, 'swm-soak-logs-');
  const lines = (file, records) => writeFileSync(path.join(logDir, file),
    records.map((record) => `${JSON.stringify(record)}\n`).join(''));
  const final = (cgId, tags) => ({
    label: 'final', cgId,
    data: { result: { bindings: tags.map((tag) => ({ s: { type: 'uri', value: `urn:swm-soak:${tag}:00001` } })) } },
  });
  const tombstone = (tag, count) => ({ tag: { type: 'literal', value: `"${tag}"` }, writesAccepted: `"${count}"` });
  lines('swm-inbox.jsonl', [final('cg-a', ['SELF', 'PEER-A', 'PEER-B']), final('cg-b', ['SELF', 'PEER-A'])]);
  lines('writes-accepted-summaries-observed.jsonl', [
    { cgId: 'cg-a', data: { result: { bindings: [tombstone('SELF', 1), tombstone('PEER-A', 1), tombstone('PEER-B', 'many')] } } },
    { cgId: 'cg-b', data: { bindings: [tombstone('PEER-A', 1)] } },
  ]);
  lines('writes.jsonl', [shared('cg-a', 1), shared('cg-b', 1)]);
  writeFileSync(path.join(logDir, 'accepted-counts.json'), '{"cg-a":1,"cg-b":1}\n');
  for (const [peersExpected, expected] of [
    ['', ['PEER-B in cg-a']],
    ['PEER-A,PEER-C,SELF', ['PEER-C in cg-a', 'PEER-C in cg-b']],
    ['PEER-A', []],
  ]) {
    const missing = await collect(spawn('python3', [TALLY, 'missing-tombstones', logDir, 'SELF', peersExpected, 'cg-a,cg-b']));
    const report = await collect(spawn('python3', [TALLY, 'report', logDir, 'SELF', peersExpected, 'cg-a,cg-b', '1']));
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(report.status, expected.length > 0 ? 1 : 0, report.stdout);
    const reportedMissing = [];
    let cgId;
    for (const line of report.stdout.split('\n')) {
      cgId = /^ {2}cg=(\S+):/.exec(line)?.[1] ?? cgId;
      const peer = /^ {4}from (\S+): \d+ observed \(no writes-accepted tombstone in cg — INDETERMINATE/.exec(line)?.[1];
      if (peer) reportedMissing.push(`${peer} in ${cgId}`);
    }
    assert.deepEqual(reportedMissing, expected, report.stdout);
    assert.equal(missing.stdout, expected.length > 0 ? `${expected.join(', ')}\n` : '');
  }
});

// A daemon for the soak script. It shares each write at once, except the seqs
// in `partials`, which it accepts as retryable partials whose share job walks
// through `jobStates` (one state per status request) and shares the write
// when the job succeeds. It answers the scoped SWM queries with the writes and
// tombstones it holds, plus those of `peers`: each peer's writes, and its
// tombstone with its `late` writes from the `from`-th tombstone query on. With
// `slowTombstones`, every tombstone query after the first `after` is answered
// only `delayMs` later. `queries` records when each query arrived.
async function soakDaemon(t, { partials = new Map(), jobStates = {}, peers = [], slowTombstones } = {}) {
  const graphs = new Map();
  const graph = (cgId) => graphs.get(cgId) ?? graphs.set(cgId, new Map()).get(cgId);
  const jobs = new Map();
  const delayed = new Set();
  t.after(() => { for (const timer of delayed) clearTimeout(timer); });
  const daemon = { tombstones: [], polls: new Map(), tombstoneQueries: 0, queries: [], unexpected: [] };
  const peerRows = (summaries) => peers.flatMap((peer) => {
    const arrived = daemon.tombstoneQueries >= peer.from;
    if (summaries) return arrived ? [{ tag: peer.tag, writesAccepted: peer.writes }] : [];
    return Array.from({ length: peer.writes }, (_, index) => index + 1)
      .filter((seq) => arrived || !peer.late.includes(seq))
      .map((seq) => ({ s: `urn:swm-soak:${peer.tag}:${String(seq).padStart(5, '0')}` }));
  });
  const server = createServer(async (request, response) => {
    let input = '';
    for await (const chunk of request) input += chunk;
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const route = `${request.method} ${request.url}`;
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      daemon.unexpected.push(`unauthorized ${route}`);
      return reply(401, { error: 'unauthorized' });
    }
    if (route === 'GET /api/info') return reply(200, { peerId: '12D3KooWSoakTestPeer' });
    if (route === 'GET /api/slo') return reply(200, { protocols: {}, gossip: {}, swm: {} });
    const job = /^GET \/api\/knowledge-assets\/swm\/share-jobs\/([^/]+)$/.exec(route);
    if (job) {
      const jobId = decodeURIComponent(job[1]);
      const poll = (daemon.polls.get(jobId) ?? 0) + 1;
      daemon.polls.set(jobId, poll);
      const states = jobStates[jobId] ?? ['succeeded'];
      const state = states[Math.min(poll, states.length) - 1];
      if (state === 'succeeded') graph(jobs.get(jobId).cgId).set(jobs.get(jobId).subject, true);
      return reply(200, { jobId, state, attempts: poll });
    }
    if (route === 'POST /api/knowledge-assets') {
      const { contextGraphId: cgId, quads } = JSON.parse(input);
      const subject = quads[0].subject;
      const value = (predicate) => quads.find((quad) => quad.predicate === predicate)?.object.replace(/^"|"$/g, '');
      if (subject.startsWith('urn:swm-soak-summary:')) {
        daemon.tombstones.push({ cgId, tag: value('urn:swm-soak:sentBy'), writesAccepted: value('urn:swm-soak:writesAccepted') });
        return reply(200, { status: 'swm-shared', swmShared: true });
      }
      const jobId = partials.get(Number(subject.split(':').pop()));
      graph(cgId).set(subject, !jobId);
      if (!jobId) return reply(200, { status: 'swm-shared', swmShared: true });
      jobs.set(jobId, { cgId, subject });
      return reply(503, retryablePartial(jobId));
    }
    if (route === 'POST /api/query') {
      const { sparql, contextGraphId: cgId } = JSON.parse(input);
      if (sparql.includes('urn:swm-soak:writesAccepted')) {
        daemon.tombstoneQueries += 1;
        daemon.queries.push({ kind: 'tombstones', cgId, at: Date.now() });
        const rows = [...daemon.tombstones.filter((entry) => entry.cgId === cgId), ...peerRows(true)];
        const answer = () => reply(200, { result: { bindings: rows.map(({ tag, writesAccepted }) => ({
          s: `urn:swm-soak-summary:${tag}:cohort`, tag: `"${tag}"`, writesAccepted: `"${writesAccepted}"`,
        })) } });
        if (!slowTombstones || daemon.tombstoneQueries <= slowTombstones.after) return answer();
        const timer = setTimeout(() => {
          delayed.delete(timer);
          if (!request.socket.destroyed) answer();
        }, slowTombstones.delayMs);
        delayed.add(timer);
        return undefined;
      }
      daemon.queries.push({ kind: 'inbox', cgId, at: Date.now() });
      const own = [...graph(cgId)].filter(([, visible]) => visible).map(([s]) => ({ s }));
      return reply(200, { result: { bindings: [...own, ...peerRows(false)] } });
    }
    daemon.unexpected.push(route);
    return reply(404, { error: `unexpected ${route}` });
  });
  daemon.api = await listen(t, server);
  return daemon;
}

// Runs the soak script against `api` with a `sleep` that returns at once: the
// daemon answers straight away, so the soak's pacing would only cost time.
async function runSoak(t, api, settings) {
  const home = tempDir(t, 'swm-soak-home-');
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/^(?:SWM_|SOAK_|DKG_|PEERS_EXPECTED$|SENDER_TAG$|AUTH$|API$)/.test(name)));
  const child = spawn(BASH, [SOAK], {
    env: {
      ...inherited,
      PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
      DKG_HOME: home, API: api, AUTH: TOKEN, SWM_INTERVAL_S: '0', SWM_SETTLE_S: '0',
      ...settings,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = await collect(child);
  const logs = readdirSync(home).find((name) => name.startsWith('swm-soak-test-'));
  const logDir = logs && path.join(home, logs);
  return { ...result, logDir, read: (name) => readFileSync(path.join(logDir, name), 'utf8') };
}

test('nine writes shared at once and one whose share job succeeds count as ten in the tombstone, the summary and the self tally', async (t) => {
  const daemon = await soakDaemon(t, { partials: new Map([[10, 'job-10']]), jobStates: { 'job-10': ['running', 'succeeded'] } });
  const run = await runSoak(t, daemon.api, {
    SENDER_TAG: 'SOLO', SWM_CG_PUBLIC: 'cg-a', SWM_TOTAL_CYCLES: '10', SWM_RECOVERY_WAIT_S: '60',
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(daemon.unexpected, []);
  assert.equal(daemon.polls.get('job-10'), 2);
  assert.deepEqual(readJsonLines(path.join(run.logDir, 'share-recoveries.jsonl')).map(({ cgId, seq, jobId, state, settled }) => ({
    cgId, seq, jobId, state, settled,
  })), [{ cgId: 'cg-a', seq: 10, jobId: 'job-10', state: 'succeeded', settled: true }]);
  assert.deepEqual(JSON.parse(run.read('accepted-counts.json')), { 'cg-a': 10 });
  // The tombstone, the summary and the self tally.
  assert.deepEqual(daemon.tombstones, [{ cgId: 'cg-a', tag: 'SOLO', writesAccepted: '10' }]);
  assert.match(run.stdout, /writes accepted by local daemon: 10\n/);
  assert.match(run.stdout, /self \(SOLO\): 10\/10 = 100\.00%/);
  assert.match(run.stdout, /VERDICT: PASS/);
  assert.doesNotMatch(run.stdout, /Waiting up to \d+s for writes-accepted tombstones/);
});

test('a receiver waits for a tombstone a peer publishes late, then counts the write that peer shared late', async (t) => {
  const daemon = await soakDaemon(t, { peers: [{ tag: 'LATE', writes: 2, late: [2], from: 3 }] });
  const run = await runSoak(t, daemon.api, {
    SENDER_TAG: 'RECV', PEERS_EXPECTED: 'LATE', SOAK_COHORT_ID: 'cohort', SWM_CG_PUBLIC: 'cg-a',
    SWM_TOTAL_CYCLES: '1', SWM_RECOVERY_WAIT_S: '60',
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(daemon.unexpected, []);
  assert.equal(daemon.tombstoneQueries, 3);
  assert.match(run.stdout, /Waiting up to 60s for writes-accepted tombstones not observed yet: LATE in cg-a/);
  assert.match(run.stdout, /from LATE: 2\/2 = 100\.00%/);
  assert.match(run.stdout, /self \(RECV\): 1\/1 = 100\.00%/);
  assert.match(run.stdout, /VERDICT: PASS/);
});

test('a receiver waits for a missing tombstone only within its budget, even when tombstone queries hang', async (t) => {
  const budgetMs = 3000;
  const daemon = await soakDaemon(t, {
    peers: [{ tag: 'GONE', writes: 1, late: [], from: Infinity }],
    // The final snapshot asks each graph once; every later tombstone query
    // would take twice the whole wait to answer.
    slowTombstones: { after: 2, delayMs: 2 * budgetMs },
  });
  const run = await runSoak(t, daemon.api, {
    SENDER_TAG: 'RECV', PEERS_EXPECTED: 'GONE', SOAK_COHORT_ID: 'cohort', SWM_CG_PUBLIC: 'cg-a,cg-b',
    SWM_TOTAL_CYCLES: '1', SWM_RECOVERY_WAIT_S: String(budgetMs / 1000),
  });
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(daemon.unexpected, []);
  const tombstoneQueries = daemon.queries.filter(({ kind }) => kind === 'tombstones');
  assert.deepEqual(tombstoneQueries.slice(0, 2).map(({ cgId }) => cgId), ['cg-a', 'cg-b']);
  const polls = tombstoneQueries.slice(2);
  assert.ok(polls.length > 0, 'the receiver polled for the missing tombstone');
  // The wait's deadline is set before its first poll, so it falls within one
  // budget of that poll: no query may start later.
  for (const poll of polls) {
    assert.ok(poll.at - polls[0].at < budgetMs + 500,
      `the tombstone query for ${poll.cgId} started ${poll.at - polls[0].at} ms into a ${budgetMs} ms wait`);
  }
  // Right after the wait, the receiver takes the final inbox snapshot again.
  const resnapshot = daemon.queries.find(({ kind, at }) => kind === 'inbox' && at > polls[0].at);
  assert.ok(resnapshot, 'the receiver took the final inbox snapshot again');
  assert.ok(resnapshot.at - polls[0].at < budgetMs + 2000,
    `the wait took ${resnapshot.at - polls[0].at} ms for a ${budgetMs} ms budget`);
  assert.match(run.stdout, /still not observed after 3s: GONE in cg-a, GONE in cg-b/);
  for (const cgId of ['cg-a', 'cg-b']) {
    assert.match(run.stdout, new RegExp(`cg=${cgId}:\\n {4}self \\(RECV\\): 1/1 = 100\\.00%.*\\n`
      + ' {4}from GONE: 1 observed \\(no writes-accepted tombstone in cg — INDETERMINATE'));
  }
  assert.match(run.stdout, /VERDICT: FAIL/);
});

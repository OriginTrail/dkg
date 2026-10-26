// CLI coverage of async-queue-seed-history.mjs --load (OT-RFC-73 P2a): the existing-data safeguard that refuses to load
// history into a namespace whose queue control graph already holds rows, or that cannot be inspected, unless
// --force-nonempty. The script runs as a child process against a loopback HTTP server that records every request it
// receives, so each case asserts both the exit code and whether any N-Quads reached the namespace. Uses the real built
// dist: run pnpm run build:packages first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadDist } from '../../repro/async-queue-contention/backend.mjs';

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../repro/async-queue-seed-history.mjs');
const JOBS = 3;
const QUADS_PER_JOB = 8;
const BASE_TIME = '1790000000000';
const CASE = { timeout: 60_000 };

let deps;
let dir;
before(async () => {
  deps = await loadDist();
  dir = mkdtempSync(path.join(tmpdir(), 'aqc-seed-cli-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A loopback namespace endpoint. answerInspection(req, res) replies to the ASK of the guard; an N-Quads POST is
 * acknowledged. Every request is recorded, so a case can assert that nothing was loaded.
 */
async function fixtureNamespace(answerInspection) {
  const requests = [];
  const server = createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const request = {
        method: req.method,
        type: req.headers['content-type'],
        body: Buffer.concat(parts).toString('utf8'),
      };
      requests.push(request);
      if (request.type === 'text/x-nquads') res.end('ok');
      else answerInspection(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/bigdata/namespace/aqc/sparql`,
    inspections: () => requests.filter((r) => r.type === 'application/sparql-query'),
    loads: () => requests.filter((r) => r.type === 'text/x-nquads'),
    close: () => server.close(),
  };
}

const answerJson = (body) => (req, res) => {
  res.setHeader('content-type', 'application/sparql-results+json');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const answerStatus = (status, body = 'boom') => (req, res) => {
  res.statusCode = status;
  res.end(body);
};
const dropConnection = (req) => req.socket.destroy();

// Async spawn: the fixture server lives in this process, so a blocking spawnSync would leave it unable to answer.
function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let seq = 0;
async function seedAndLoad(answerInspection, { forceNonempty = false } = {}) {
  const ns = await fixtureNamespace(answerInspection);
  const seedFile = path.join(dir, `seed-${seq++}.nq`);
  try {
    const args = ['--jobs', String(JOBS), '--base-time', BASE_TIME, '--out', seedFile, '--load', ns.url];
    if (forceNonempty) args.push('--force-nonempty');
    const result = await runCli(args);
    return { ...result, seedFile, inspections: ns.inspections(), loads: ns.loads() };
  } finally {
    ns.close();
  }
}

function assertLoaded(r) {
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.loads.length >= 1, 'the history was posted');
  assert.equal(
    r.loads.map((p) => p.body).join(''),
    readFileSync(r.seedFile, 'utf8'),
    'what the namespace received is exactly the seed file',
  );
  const manifest = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(manifest.loaded.quads, JOBS * QUADS_PER_JOB);
  assert.equal(manifest.loaded.sha256, manifest.sha256, 'the bytes loaded are the bytes of the seed file');
}

function assertRefused(r, reason) {
  assert.notEqual(r.code, 0, 'the CLI refuses with a non-zero exit');
  assert.deepEqual(r.loads, [], 'not a single N-Quads POST reached the namespace');
  assert.equal(r.stdout, '', 'no manifest is printed for a seed that was not loaded');
  assert.match(r.stderr, reason);
}

test('an empty control graph (ASK false) is inspected once and then loaded', CASE, async () => {
  const r = await seedAndLoad(answerJson({ head: {}, boolean: false }));
  assert.equal(r.inspections.length, 1, 'the namespace is inspected once, before the load');
  assert.equal(r.inspections[0].method, 'POST');
  assert.equal(
    r.inspections[0].body,
    `ASK { { GRAPH <${deps.utils.DEFAULT_PROMOTE_CONTROL_GRAPH_URI}> { ?s ?p ?o } } }`,
    'the guard asks about the share queue control graph (the one graph a share seed lives in)',
  );
  assertLoaded(r);
});

test('a non-empty control graph (ASK true) is refused and nothing is loaded', CASE, async () => {
  const r = await seedAndLoad(answerJson({ head: {}, boolean: true }));
  assert.equal(r.inspections.length, 1);
  assertRefused(r, /not empty; use --force-nonempty/);
  assert.equal(existsSync(r.seedFile), false, 'the refusal comes before any seed is generated');
});

test('an inspection that fails (HTTP 500) is refused and nothing is loaded', CASE, async () => {
  const r = await seedAndLoad(answerStatus(500));
  assert.equal(r.inspections.length, 1);
  assertRefused(r, /could not inspect .*HTTP 500/);
});

test('an inspection that cannot be read as an ASK answer is refused and nothing is loaded', CASE, async () => {
  const malformed = [
    ['a body that is not JSON', '<html>not sparql</html>'],
    ['an empty body', ''],
    ['JSON without the ASK boolean', { head: { vars: ['s'] }, results: { bindings: [] } }],
    ['a boolean that is not a boolean', { boolean: 'false' }],
  ];
  for (const [what, body] of malformed) {
    const r = await seedAndLoad(answerJson(body));
    assert.equal(r.inspections.length, 1, what);
    assert.notEqual(r.code, 0, `${what}: the CLI refuses with a non-zero exit`);
    assert.deepEqual(r.loads, [], `${what}: not a single N-Quads POST reached the namespace`);
    assert.equal(r.stdout, '', `${what}: no manifest is printed`);
    assert.match(r.stderr, /could not inspect .*not a SPARQL ASK result/, `${what}: a clean refusal, not a crash`);
  }
});

test('an inspection that gets no answer (connection dropped) is refused and nothing is loaded', CASE, async () => {
  const r = await seedAndLoad(dropConnection);
  assert.equal(r.inspections.length, 1);
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.loads, []);
  assert.equal(r.stdout, '');
});

test('--force-nonempty loads into a namespace that answers non-empty', CASE, async () => {
  const r = await seedAndLoad(answerJson({ head: {}, boolean: true }), { forceNonempty: true });
  assertLoaded(r);
});

test('--force-nonempty also loads when the namespace cannot be inspected', CASE, async () => {
  const r = await seedAndLoad(answerStatus(500), { forceNonempty: true });
  assertLoaded(r);
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  awaitExpectations, classifyRead, describeResult, expectationsExit, literalText, queryFor, validateExpectations,
} from '../qa/expected-state.mjs';

const cli = fileURLToPath(new URL('../qa/expected-state-cli.mjs', import.meta.url));
const expectation = (overrides = {}) => ({
  label: 'node 2 reads the asset', node: 2, contextGraphId: 'graph-a', view: 'verifiable-memory',
  subject: 'urn:upgrade:1:asset', values: ['asset v2'], ...overrides,
});
const rows = (...names) => ({
  transportExit: 0, httpStatus: 200,
  body: JSON.stringify({ result: { type: 'bindings', bindings: names.map(name => ({ name })) } }),
});
const settling = {
  transportExit: 0, httpStatus: 503,
  body: JSON.stringify({ error: 'unavailable', code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE', retryable: true }),
};

test('the query is scoped to the graph and the view and reads the name of the subject only', () => {
  assert.deepEqual(queryFor(expectation()), {
    sparql: 'SELECT ?name WHERE { <urn:upgrade:1:asset> <http://schema.org/name> ?name }',
    contextGraphId: 'graph-a', view: 'verifiable-memory',
  });
});

test('a literal reads the same from a canonical term, a typed or tagged term and a results-JSON cell', () => {
  assert.equal(literalText('"asset v2"'), 'asset v2');
  assert.equal(literalText('"asset v2"^^<http://www.w3.org/2001/XMLSchema#string>'), 'asset v2');
  assert.equal(literalText('"asset v2"@en-GB'), 'asset v2');
  assert.equal(literalText({ type: 'literal', value: 'asset v2' }), 'asset v2');
  assert.equal(literalText('"say \\"hi\\" \\\\ there"'), 'say "hi" \\ there');
});

test('exactly the expected values are met; an old value kept beside the new one is not', () => {
  assert.deepEqual(classifyRead(expectation(), rows('"asset v2"')), { state: 'met', values: ['asset v2'] });
  // The same value from two graphs is one value.
  assert.equal(classifyRead(expectation(), rows('"asset v2"', '"asset v2"')).state, 'met');
  assert.deepEqual(classifyRead(expectation(), rows('"asset v1"', '"asset v2"')),
    { state: 'different', values: ['asset v1', 'asset v2'] });
  assert.deepEqual(classifyRead(expectation(), rows()), { state: 'different', values: [] });
  assert.equal(classifyRead(expectation({ values: [] }), rows()).state, 'met');
});

test('a tolerated value may be read beside the expected ones, is reported, and tolerates nothing else', () => {
  const writer = expectation({ values: ['asset v3'], tolerated: ['asset v1'] });
  assert.deepEqual(classifyRead(writer, rows('"asset v3"')), { state: 'met', values: ['asset v3'] });
  assert.deepEqual(classifyRead(writer, rows('"asset v1"', '"asset v3"')),
    { state: 'met', values: ['asset v1', 'asset v3'], tolerated: ['asset v1'] });
  // The tolerated value alone is not the expected state, and no other leftover is accepted.
  assert.deepEqual(classifyRead(writer, rows('"asset v1"')), { state: 'different', values: ['asset v1'] });
  assert.deepEqual(classifyRead(writer, rows('"asset v2"', '"asset v3"')),
    { state: 'different', values: ['asset v2', 'asset v3'] });
  assert.deepEqual(classifyRead(writer, rows('"asset v1"', '"asset v2"', '"asset v3"')).state, 'different');

  const result = { expectation: { ...writer, label: 'writer' }, met: true, afterMs: 2_000, polls: 1, last: classifyRead(writer, rows('"asset v1"', '"asset v3"')) };
  assert.equal(describeResult(result), 'ok     writer (after 2s, 1 read); also read ["asset v1"], tolerated');
  const wrong = { expectation: { ...writer, label: 'writer' }, met: false, afterMs: null, polls: 2, last: classifyRead(writer, rows('"asset v2"', '"asset v3"')) };
  assert.equal(describeResult(wrong),
    'WRONG  writer: read ["asset v2","asset v3"], expected ["asset v3"] (tolerated beside them: ["asset v1"])');
});

test('an answer that is not evidence is never read as an empty result', () => {
  assert.deepEqual(classifyRead(expectation({ values: [] }), settling),
    { state: 'settling', reason: 'READ_AUTHORITY_SETTLING' });
  for (const [answer, reason] of [
    [{ transportExit: 7, httpStatus: null, body: '' }, 'TRANSPORT_FAILURE'],
    [{ transportExit: 0, httpStatus: 500, body: '{"result":{"bindings":[]}}' }, 'HTTP_ERROR'],
    [{ transportExit: 0, httpStatus: 200, body: '{"error":"denied","result":{"bindings":[]}}' }, 'API_ERROR'],
    [{ transportExit: 0, httpStatus: 200, body: 'not json' }, 'MALFORMED_JSON'],
    [{ transportExit: 0, httpStatus: 200, body: '{"result":{"bindings":[{"other":"\\"x\\""}]}}' }, 'MISSING_BINDING'],
  ]) assert.deepEqual(classifyRead(expectation({ values: [] }), answer), { state: 'invalid', reason });
});

function harness(script) {
  let clock = 0;
  const reads = [];
  return {
    reads,
    run: (expectations, { timeoutMs = 10_000, intervalMs = 1_000 } = {}) => awaitExpectations({
      expectations, timeoutMs, intervalMs,
      now: () => clock,
      sleep: async ms => { clock += ms; },
      read: async e => { reads.push(`${clock}:${e.label}`); return script(e, clock); },
    }),
  };
}

test('the wait asks again until the state arrives and does not re-read what was met', async () => {
  const first = expectation({ label: 'first' }), second = expectation({ label: 'second' });
  const { run, reads } = harness((e, clock) => (e.label === 'first' || clock >= 2_000 ? rows('"asset v2"') : rows('"asset v1"')));
  const results = await run([first, second]);
  assert.deepEqual(results.map(r => [r.met, r.afterMs, r.polls]), [[true, 0, 1], [true, 2_000, 3]]);
  assert.deepEqual(reads, ['0:first', '0:second', '1000:second', '2000:second']);
  assert.equal(expectationsExit(results), 0);
  assert.match(describeResult(results[1]), /^ok +second \(after 2s, 3 reads\)$/);
});

test('at the deadline a wrong state is a failure and an unread one is no evidence', async () => {
  const wrong = expectation({ label: 'wrong' }), unread = expectation({ label: 'unread' });
  const { run } = harness(e => (e.label === 'wrong' ? rows('"asset v1"') : settling));
  const results = await run([wrong, unread], { timeoutMs: 2_000 });
  assert.deepEqual(results.map(r => r.met), [false, false]);
  assert.equal(results[0].polls, 3);
  assert.equal(expectationsExit(results), 1);
  assert.equal(expectationsExit([results[1]]), 2);
  assert.equal(describeResult(results[0]), 'WRONG  wrong: read ["asset v1"], expected ["asset v2"]');
  assert.equal(describeResult(results[1]), 'UNREAD unread: no valid read in 3 attempts (READ_AUTHORITY_SETTLING)');
});

test('a read that throws is no evidence and the wait goes on', async () => {
  let calls = 0;
  const { run } = harness(() => { calls += 1; if (calls === 1) throw new Error('socket hang up'); return rows('"asset v2"'); });
  const [result] = await run([expectation()]);
  assert.deepEqual([result.met, result.polls], [true, 2]);
});

test('an unusable list is refused with the reason', () => {
  for (const [list, reason] of [
    [[], /non-empty array/],
    [[expectation({ view: 'working-memory' })], /view must be one of/],
    [[expectation({ subject: 'urn:x> } DROP ALL #' })], /not a safe IRI/],
    [[expectation({ node: 0 })], /positive integer/],
    [[expectation({ values: 'asset v2' })], /values must be an array of strings/],
    [[expectation({ tolerated: 'asset v1' })], /tolerated must be an array of strings/],
    [[expectation({ tolerated: [1] })], /tolerated must be an array of strings/],
    [[expectation({ label: '' })], /label is required/],
  ]) assert.throws(() => validateExpectations(list), reason);
  assert.equal(validateExpectations([expectation(), expectation({ tolerated: ['asset v1'] })]).length, 2);
});

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('the command reads each node with its own token and reports per expectation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-expected-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const server = createServer((req, res) => {
    let input = ''; req.on('data', c => input += c);
    req.on('end', () => {
      const body = JSON.parse(input);
      requests.push({ url: req.url, authorization: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (body.view === 'shared-working-memory') { res.statusCode = 503; res.end(settling.body); return; }
      if (body.contextGraphId === 'graph-c') { res.end(rows('"asset v1"', '"asset v2"').body); return; }
      res.end(rows(body.contextGraphId === 'graph-a' ? '"asset v2"' : '"asset v1"').body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  // The node number selects the port: this server stands for node 2.
  const base = server.address().port - 1;
  mkdirSync(join(dir, 'node2'));
  writeFileSync(join(dir, 'node2/auth.token'), '# DKG devnet shared auth token\nfixture-token\n');
  const file = join(dir, 'expectations.json'), out = join(dir, 'results.json');
  const common = ['--devnet-dir', dir, '--api-port-base', String(base), '--timeout-s', '0.2', '--interval-s', '0.1'];

  writeFileSync(file, JSON.stringify([expectation()]));
  const met = await runCli([file, ...common, '--out', out]);
  assert.equal(met.status, 0, met.stderr);
  assert.match(met.stdout, /^ok +node 2 reads the asset \(after 0s, 1 read\)\n$/);
  assert.equal(requests[0].url, '/api/query');
  assert.equal(requests[0].authorization, 'Bearer fixture-token');
  assert.deepEqual(requests[0].body, queryFor(expectation()));
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).map(r => [r.label, r.met, r.last.state]),
    [['node 2 reads the asset', true, 'met']]);
  assert.ok(!readFileSync(out, 'utf8').includes('fixture-token'));

  writeFileSync(file, JSON.stringify([expectation(), expectation({ label: 'stale copy', contextGraphId: 'graph-b' })]));
  const wrong = await runCli([file, ...common]);
  assert.equal(wrong.status, 1, wrong.stderr);
  assert.match(wrong.stdout, /^WRONG +stale copy: read \["asset v1"\], expected \["asset v2"\]$/m);

  writeFileSync(file, JSON.stringify([expectation({ label: 'writer copy', contextGraphId: 'graph-c', values: ['asset v2'], tolerated: ['asset v1'] })]));
  const tolerated = await runCli([file, ...common, '--out', out]);
  assert.equal(tolerated.status, 0, tolerated.stderr);
  assert.match(tolerated.stdout, /^ok +writer copy \(after 0s, 1 read\); also read \["asset v1"\], tolerated\n$/);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).map(r => [r.met, r.tolerated, r.last.tolerated]),
    [[true, ['asset v1'], ['asset v1']]]);

  writeFileSync(file, JSON.stringify([expectation({ label: 'member view', view: 'shared-working-memory' })]));
  const unread = await runCli([file, ...common]);
  assert.equal(unread.status, 2, unread.stderr);
  assert.match(unread.stdout, /^UNREAD member view: no valid read in \d+ attempts? \(READ_AUTHORITY_SETTLING\)$/m);

  const unusable = await runCli([join(dir, 'missing.json'), ...common]);
  assert.equal(unusable.status, 2);
  assert.match(unusable.stderr, /^expected-state: /);
});

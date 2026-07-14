// Hermetic tests for lib/util.mjs — no network, no fleet, no SSH.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindingSetDigest,
  fetchRetry,
  fnv1a,
  isoBasic,
  isTransientNetworkError,
  normTerm,
  parseLastJsonBlock,
  percentile,
  promiseWithTimeout,
  seededRandom,
  sha256,
  sleep,
  waitFor,
} from '../lib/util.mjs';

// ── percentile (nearest-rank, rfc59 parity) ─────────────────────────────────

test('percentile: empty array -> null', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([], 99), null);
  assert.equal(percentile([NaN, Infinity], 95), null); // non-finite filtered out
});

test('percentile: single element is every percentile', () => {
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([42], 99), 42);
  assert.equal(percentile([42], 100), 42);
});

test('percentile: rfc59 harness parity on its own test vector', () => {
  // rfc59 harness.test.mjs: percentile([50,10,40,20,30], 0.5) === 30, 0.95 === 50
  assert.equal(percentile([50, 10, 40, 20, 30], 50), 30);
  assert.equal(percentile([50, 10, 40, 20, 30], 95), 50);
  assert.equal(percentile([50, 10, 40, 20, 30], 99), 50);
});

test('percentile: exact-rank boundaries, no interpolation', () => {
  const v = [10, 20, 30, 40];
  assert.equal(percentile(v, 25), 10); // ceil(0.25*4)=1 -> rank 1
  assert.equal(percentile(v, 50), 20); // ceil(0.5*4)=2 -> rank 2
  assert.equal(percentile(v, 75), 30);
  assert.equal(percentile(v, 76), 40); // just past the exact boundary
  assert.equal(percentile(v, 100), 40);
});

test('percentile: does not mutate its input', () => {
  const v = [3, 1, 2];
  percentile(v, 50);
  assert.deepEqual(v, [3, 1, 2]);
});

// ── parseLastJsonBlock ───────────────────────────────────────────────────────

test('parseLastJsonBlock: noisy CLI stdout with logs before and after', () => {
  const out = [
    '[2026-07-14T19:00:00Z] INFO starting publish…',
    'progress: 10% {not json here',
    '{"status":"COMPLETED","ual":"did:dkg:base:84532/0xabc/1","durationMs":1234}',
    'INFO done, exiting with code 0',
  ].join('\n');
  assert.deepEqual(parseLastJsonBlock(out), {
    status: 'COMPLETED',
    ual: 'did:dkg:base:84532/0xabc/1',
    durationMs: 1234,
  });
});

test('parseLastJsonBlock: multiple objects -> the LAST one wins', () => {
  const out = '{"first":1}\nsome noise\n{"second":2}';
  assert.deepEqual(parseLastJsonBlock(out), { second: 2 });
});

test('parseLastJsonBlock: nested object returns the outermost (top-level) block', () => {
  const out = 'log line\n{"outer":{"inner":{"deep":true}},"n":1}';
  assert.deepEqual(parseLastJsonBlock(out), { outer: { inner: { deep: true } }, n: 1 });
});

test('parseLastJsonBlock: braces and escaped quotes inside strings do not break the scan', () => {
  const out = 'x\n{"msg":"boom } zap { \\" }","ok":true}';
  assert.deepEqual(parseLastJsonBlock(out), { msg: 'boom } zap { " }', ok: true });
});

test('parseLastJsonBlock: trailing stray brace after the JSON is skipped', () => {
  const out = '{"a":1} trailing } noise';
  assert.deepEqual(parseLastJsonBlock(out), { a: 1 });
});

test('parseLastJsonBlock: pure JSON and whitespace-padded JSON', () => {
  assert.deepEqual(parseLastJsonBlock('{"a":1}'), { a: 1 });
  assert.deepEqual(parseLastJsonBlock('  {"a":1}\n\n'), { a: 1 });
});

test('parseLastJsonBlock: no JSON object -> null', () => {
  assert.equal(parseLastJsonBlock('no json here at all'), null);
  assert.equal(parseLastJsonBlock(''), null);
  assert.equal(parseLastJsonBlock('{"unclosed": true'), null);
  assert.equal(parseLastJsonBlock('[1,2,3]'), null); // arrays are not objects
});

// ── normTerm / bindingSetDigest ──────────────────────────────────────────────

test('normTerm: canonical forms per term type', () => {
  assert.equal(normTerm({ type: 'uri', value: 'http://ex/a' }), '<http://ex/a>');
  assert.equal(normTerm({ type: 'bnode', value: 'b0' }), '_:b0');
  assert.equal(normTerm({ type: 'literal', value: 'plain' }), '"plain"');
  assert.equal(
    normTerm({ type: 'literal', value: '5', datatype: 'http://www.w3.org/2001/XMLSchema#integer' }),
    '"5"^^<http://www.w3.org/2001/XMLSchema#integer>',
  );
  assert.equal(
    normTerm({ type: 'literal', value: 'x', datatype: 'http://www.w3.org/2001/XMLSchema#string' }),
    '"x"', // xsd:string is elided (devnet parity)
  );
  assert.equal(normTerm({ type: 'literal', value: 'chat', 'xml:lang': 'fr' }), '"chat"@fr');
});

test('normTerm: idempotent on N-Triples term strings, tolerant of empty cells', () => {
  assert.equal(normTerm('<http://ex/a>'), '<http://ex/a>');
  assert.equal(normTerm('"v"@en'), '"v"@en');
  assert.equal(normTerm('_:b1'), '_:b1');
  assert.equal(normTerm({ type: 'uri', value: '<http://ex/a>' }), '<http://ex/a>');
  assert.equal(normTerm(null), '');
  assert.equal(normTerm(undefined), '');
  assert.equal(normTerm({}), '');
});

test('bindingSetDigest: insensitive to row order and binding key order', () => {
  const a = {
    head: { vars: ['s', 'o'] },
    results: {
      bindings: [
        { s: { type: 'uri', value: 'http://ex/1' }, o: { type: 'literal', value: 'x' } },
        { s: { type: 'uri', value: 'http://ex/2' }, o: { type: 'literal', value: 'y' } },
      ],
    },
  };
  const b = {
    head: { vars: ['o', 's'] },
    results: {
      bindings: [
        { o: { type: 'literal', value: 'y' }, s: { type: 'uri', value: 'http://ex/2' } },
        { o: { type: 'literal', value: 'x' }, s: { type: 'uri', value: 'http://ex/1' } },
      ],
    },
  };
  assert.equal(bindingSetDigest(a), bindingSetDigest(b));
});

test('bindingSetDigest: different content -> different digest; empty set is stable', () => {
  const base = {
    head: { vars: ['s'] },
    results: { bindings: [{ s: { type: 'uri', value: 'http://ex/1' } }] },
  };
  const other = {
    head: { vars: ['s'] },
    results: { bindings: [{ s: { type: 'uri', value: 'http://ex/2' } }] },
  };
  assert.notEqual(bindingSetDigest(base), bindingSetDigest(other));
  assert.equal(
    bindingSetDigest({ head: { vars: [] }, results: { bindings: [] } }),
    sha256(''),
  );
});

test('bindingSetDigest: structured and term-string cells digest identically', () => {
  const structured = {
    head: { vars: ['s'] },
    results: { bindings: [{ s: { type: 'uri', value: 'http://ex/1' } }] },
  };
  const termString = {
    head: { vars: ['s'] },
    results: { bindings: [{ s: '<http://ex/1>' }] },
  };
  assert.equal(bindingSetDigest(structured), bindingSetDigest(termString));
});

// ── sha256 ───────────────────────────────────────────────────────────────────

test('sha256: known vectors, string and Buffer', () => {
  assert.equal(
    sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(sha256(Buffer.from('abc')), sha256('abc'));
  assert.equal(
    sha256(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

// ── waitFor / promiseWithTimeout / fetchRetry ───────────────────────────────

test('waitFor: resolves the truthy probe value', async () => {
  let calls = 0;
  const v = await waitFor('thing', 500, 1, () => (++calls >= 3 ? { got: calls } : null));
  assert.deepEqual(v, { got: 3 });
  assert.equal(calls, 3);
});

test('waitFor: throws the contract timeout message', async () => {
  await assert.rejects(
    waitFor('never-ready', 10, 1, () => false),
    { message: 'waitFor timeout: never-ready' },
  );
});

test('promiseWithTimeout: passes through a fast promise', async () => {
  assert.equal(await promiseWithTimeout(Promise.resolve(7), 100, 'fast'), 7);
});

test('promiseWithTimeout: rejects with the contract message on timeout', async () => {
  await assert.rejects(
    promiseWithTimeout(sleep(200), 10, 'slow-op'),
    { message: 'slow-op timeout after 10ms' },
  );
});

test('promiseWithTimeout: propagates the inner rejection', async () => {
  await assert.rejects(
    promiseWithTimeout(Promise.reject(new Error('inner')), 100, 'x'),
    { message: 'inner' },
  );
});

test('fetchRetry: retries transient errors then succeeds', async () => {
  let calls = 0;
  const resp = { ok: true, status: 200 };
  const _fetch = async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return resp;
  };
  const got = await fetchRetry('http://127.0.0.1:1/x', undefined, { _fetch, backoffMs: 0 });
  assert.equal(got, resp);
  assert.equal(calls, 3);
});

test('fetchRetry: HTTP error statuses are returned, never retried', async () => {
  let calls = 0;
  const _fetch = async () => { calls++; return { ok: false, status: 503 }; };
  const got = await fetchRetry('http://127.0.0.1:1/x', undefined, { _fetch, backoffMs: 0 });
  assert.equal(got.status, 503);
  assert.equal(calls, 1);
});

test('fetchRetry: non-transient errors are rethrown without retry', async () => {
  let calls = 0;
  const _fetch = async () => { calls++; throw new Error('certificate has expired'); };
  await assert.rejects(
    fetchRetry('http://127.0.0.1:1/x', undefined, { _fetch, backoffMs: 0 }),
    { message: 'certificate has expired' },
  );
  assert.equal(calls, 1);
});

test('fetchRetry: exhausts retries and rethrows the last transient error', async () => {
  let calls = 0;
  const _fetch = async () => { calls++; throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); };
  await assert.rejects(
    fetchRetry('http://127.0.0.1:1/x', undefined, { _fetch, retries: 2, backoffMs: 0 }),
    { message: 'socket hang up' },
  );
  assert.equal(calls, 3); // 1 initial + 2 retries (devnet 3-tries parity)
});

test('isTransientNetworkError: classification, including undici cause chains', () => {
  assert.equal(isTransientNetworkError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), true);
  assert.equal(isTransientNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } })), true);
  assert.equal(isTransientNetworkError(new Error('socket hang up')), true);
  assert.equal(isTransientNetworkError(new Error('ENOTFOUND example.invalid')), false);
  assert.equal(isTransientNetworkError(undefined), false);
});

// ── seededRandom / fnv1a / isoBasic ─────────────────────────────────────────

test('seededRandom: deterministic per seed, divergent across seeds, range [0,1)', () => {
  const a1 = seededRandom('certify-100:run-1');
  const a2 = seededRandom('certify-100:run-1');
  const b = seededRandom('certify-100:run-2');
  const seqA1 = Array.from({ length: 8 }, () => a1());
  const seqA2 = Array.from({ length: 8 }, () => a2());
  const seqB = Array.from({ length: 8 }, () => b());
  assert.deepEqual(seqA1, seqA2);
  assert.notDeepEqual(seqA1, seqB);
  for (const x of [...seqA1, ...seqB]) {
    assert.equal(typeof x, 'number');
    assert.ok(x >= 0 && x < 1, `out of range: ${x}`);
  }
});

test('fnv1a: stable 32-bit reference values', () => {
  assert.equal(fnv1a(''), 0x811c9dc5);
  assert.equal(fnv1a('a'), 0xe40c292c);
  assert.equal(fnv1a('foobar'), 0xbf9cf968);
});

test('isoBasic: YYYYMMDDTHHMMSSZ, UTC, no separators', () => {
  assert.equal(isoBasic(new Date('2026-07-14T19:00:00.123Z')), '20260714T190000Z');
  assert.match(isoBasic(), /^\d{8}T\d{6}Z$/);
});

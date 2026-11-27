import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  AUTHORITY_CODE, AUTHORITY_RETRY_DELAYS_MS, AUTHORITY_RETRY_MAX_DELAY_MS, READ_AUTHORITY_CODE,
  askWithAuthorityRetry, authorityRetryDelayMs, isRetryableAuthorityAnswer, retryAfterMs,
} from '../qa/authority-retry.mjs';

const read = { error: 'x', code: READ_AUTHORITY_CODE, retryable: true };
const authority = { error: 'x', code: AUTHORITY_CODE, retryable: true };

test('only the 503 that carries a retryable authority code is the retryable answer', () => {
  assert.equal(isRetryableAuthorityAnswer(503, read), true);
  assert.equal(isRetryableAuthorityAnswer(503, authority), true);
  for (const [status, json] of [
    [500, read], [200, read], [503, { ...read, retryable: 'true' }], [503, { code: READ_AUTHORITY_CODE }],
    [503, { code: 'STORE_SCHEDULER_BUSY', retryable: true }], [503, null], [503, 'text'], [503, undefined],
    [503, [read]],
  ]) assert.equal(isRetryableAuthorityAnswer(status, json), false, JSON.stringify([status, json]));
});

test('a request may narrow the codes it repeats on', () => {
  assert.equal(isRetryableAuthorityAnswer(503, read, [AUTHORITY_CODE]), false);
  assert.equal(isRetryableAuthorityAnswer(503, authority, [AUTHORITY_CODE]), true);
});

test('Retry-After reads as delta-seconds or an HTTP-date, and anything else as absent', () => {
  assert.equal(retryAfterMs('3'), 3_000);
  assert.equal(retryAfterMs(' 0 '), 0);
  const now = Date.parse('Fri, 30 Oct 2026 09:00:00 GMT');
  assert.equal(retryAfterMs('Fri, 30 Oct 2026 09:00:07 GMT', now), 7_000);
  assert.equal(retryAfterMs('Fri, 30 Oct 2026 08:59:00 GMT', now), 0, 'a date in the past asks for no wait');
  for (const value of [null, undefined, '', '-1', '3.5', 'soon', '1e3', 'Fri, 30 Oct 2026']) {
    assert.equal(retryAfterMs(value, now), undefined, String(value));
  }
});

test('the wait is the back-off, or Retry-After when that is longer, and ends at the bound', () => {
  assert.deepEqual(AUTHORITY_RETRY_DELAYS_MS.map((_, retry) => authorityRetryDelayMs(retry)), [1_000, 2_000, 4_000, 8_000]);
  assert.deepEqual([0, 1, 2, 3].map(retry => authorityRetryDelayMs(retry, '3')), [3_000, 3_000, 4_000, 8_000]);
  assert.equal(authorityRetryDelayMs(4), null, 'the retries are spent');
  assert.equal(authorityRetryDelayMs(4, '1'), null);
  assert.equal(authorityRetryDelayMs(0, String(AUTHORITY_RETRY_MAX_DELAY_MS / 1_000)), AUTHORITY_RETRY_MAX_DELAY_MS);
  assert.equal(authorityRetryDelayMs(0, String(AUTHORITY_RETRY_MAX_DELAY_MS / 1_000 + 1)), null, 'longer than it may wait');
  assert.equal(authorityRetryDelayMs(0, '9'.repeat(400)), null, 'a number too large for a double stays over the bound');
});

/** A client whose `ask` answers each of `answers` in turn (the last repeats) and whose waits are noted. */
function scripted(answers) {
  const waits = [];
  let asked = 0;
  return {
    ask: async () => answers[Math.min(asked++, answers.length - 1)],
    options: { sleep: async ms => { waits.push(ms); } },
    waits,
    asked: () => asked,
  };
}
const unavailable = (json = read, retryAfter = null) => ({ status: 503, json, retryAfter });
const served = { status: 200, json: { ok: true }, retryAfter: null };

test('a client asks again until it is served, waiting what the node asks for', async () => {
  const client = scripted([unavailable(read, '3'), unavailable(authority, '1'), served]);
  assert.equal(await askWithAuthorityRetry(client.ask, client.options), served);
  assert.deepEqual(client.waits, [3_000, 2_000]);
});

test('a client gives back the last answer when its retries run out', async () => {
  const last = unavailable();
  const client = scripted([last]);
  assert.equal(await askWithAuthorityRetry(client.ask, client.options), last);
  assert.equal(client.asked(), 5);
  assert.deepEqual(client.waits, [1_000, 2_000, 4_000, 8_000]);
});

test('a client does not repeat any other answer, nor one over its bound', async () => {
  for (const answer of [
    { status: 503, json: { code: 'STORE_SCHEDULER_BUSY', retryable: true } },
    { status: 500, json: read }, { status: 403, json: { error: 'no' } }, served,
    unavailable(read, '60'),
  ]) {
    const client = scripted([answer, served]);
    assert.equal(await askWithAuthorityRetry(client.ask, client.options), answer);
    assert.equal(client.asked(), 1);
  }
});

test('a request limited to one code does not repeat on the other', async () => {
  const client = scripted([unavailable(read), served]);
  const answer = await askWithAuthorityRetry(client.ask, { ...client.options, codes: [AUTHORITY_CODE] });
  assert.equal(answer.json, read);
  assert.equal(client.asked(), 1);
});

test('each retry is reported before its wait', async () => {
  const client = scripted([unavailable(read, '2'), served]);
  const events = [];
  await askWithAuthorityRetry(client.ask, {
    sleep: async ms => { events.push(`slept ${ms}`); },
    onRetry: ({ retry, delayMs }) => { events.push(`retry ${retry} in ${delayMs}`); },
  });
  assert.deepEqual(events, ['retry 1 in 2000', 'slept 2000']);
});

test('a real wait passes without a sleep of the caller', async () => {
  const client = scripted([unavailable(read, '0'), served]);
  const started = Date.now();
  assert.equal(await askWithAuthorityRetry(client.ask), served);
  assert.ok(Date.now() - started >= 900, 'the first back-off was waited out');
});

const cli = fileURLToPath(new URL('../qa/authority-retry-cli.mjs', import.meta.url));
const wait = (retry, headersFile) => spawnSync(process.execPath, [cli, String(retry), headersFile], { encoding: 'utf8' });

test('the shell form reads the wait from a dump of the answer\'s headers', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-authority-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const headers = join(dir, 'headers');
  writeFileSync(headers, 'HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nretry-AFTER: 3\r\n\r\n');
  assert.equal(wait(0, headers).stdout.trim(), '3');
  assert.equal(wait(2, headers).stdout.trim(), '4');
  const spent = wait(4, headers);
  assert.equal(spent.status, 1); assert.equal(spent.stdout, '');
  writeFileSync(headers, 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 900\r\n\r\n');
  assert.equal(wait(0, headers).status, 1, 'longer than one wait may take');
  writeFileSync(headers, 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 9\r\n\r\nHTTP/1.1 503 Service Unavailable\r\n\r\n');
  assert.equal(wait(0, headers).stdout.trim(), '1', 'only the last block of the dump is the answer');
  assert.equal(wait(1, join(dir, 'absent')).stdout.trim(), '2', 'without headers the back-off decides');
});

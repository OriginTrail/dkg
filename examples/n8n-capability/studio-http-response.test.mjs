import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioProvider } from './studio-provider.mjs';
import { createStudioNativeRunner } from './studio-native-runner.mjs';

function installation(t) {
  const state = mkdtempSync(join(tmpdir(), 'studio-http-limit-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const token = join(state, 'fixture-token'); writeFileSync(token, 'fictional-studio-http-token'.repeat(3));
  return { baseUrl: 'http://127.0.0.1:1', apiTokenFile: token, webhookTokenFile: token, workflows: [] };
}
test('native exchange sends the admitted envelope and rejects acknowledgements containing anything but an execution ID', async t => {
  const input = { itemsJson: '[{"name":"Équipement"}]', paramsJson: '{}', executionId: '' };
  const replies = [{ executionId: '42', output: {} }, { executionId: 42 }, { executionId: '42/other' }, {}, null, []];
  const runner = createStudioNativeRunner({}, installation(t), async (url, options) => {
    assert.equal(url.pathname, '/webhook/dkg-capability-native-one');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.signal.aborted, false);
    assert.deepEqual(JSON.parse(options.body), { invocationId: 'run:with:colons', input });
    return Response.json(replies.shift());
  });
  while (replies.length) await assert.rejects(runner.dispatch({ grant: { workflowId: 'native-one' } }, 'run:with:colons', input),
    { code: 'STUDIO_NATIVE_UNCONFIRMED', status: 409 });
});
const targets = [
  { name: 'provider API', limit: 1_048_576, body: { text: 'Équipement 🛠' }, expected: { text: 'Équipement 🛠' },
    limitError: { code: 'INVALID_WORKFLOW', status: 409, message: 'n8n response exceeds the PoC limit.' },
    httpError: { code: 'INVALID_WORKFLOW', status: 409, message: 'n8n did not confirm provisioning (503). Retry this save.' },
    request(t, response) {
      const provider = createStudioProvider({ config: { n8nNative: installation(t) }, fetchImpl: async () => response });
      return provider.api('/workflows/native-one');
    } },
  { name: 'native acknowledgement', limit: 512, body: { executionId: '42' }, expected: '42',
    limitError: { code: 'STUDIO_NATIVE_UNCONFIRMED', status: 409 },
    httpError: { code: 'STUDIO_NATIVE_UNCONFIRMED', status: 409 },
    request(t, response) {
      const runner = createStudioNativeRunner({}, installation(t), async () => response);
      return runner.dispatch({ grant: { workflowId: 'native-one' } }, 'run-one', { itemsJson: '[]', paramsJson: '{}', executionId: '' });
    } },
];

function padded(target, size) {
  const json = Buffer.from(JSON.stringify(target.body));
  return Buffer.concat([json, Buffer.alloc(size - json.length, 0x20)]);
}
function streamed(bytes, limit, headers) {
  // Split the provider JSON inside a multibyte code point. A separate final
  // chunk crosses the ceiling, so overflow must cancel an open stream.
  const unicode = bytes.indexOf(0xc3), split = unicode < 0 ? 7 : unicode + 1;
  const chunks = [bytes.subarray(0, split), bytes.subarray(split, limit), bytes.subarray(limit)].filter(chunk => chunk.length);
  let reads = 0, cancelled = 0;
  const body = new ReadableStream({
    pull(controller) { reads++; if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers }), body, get reads() { return reads; }, get cancelled() { return cancelled; } };
}

for (const target of targets) {
  test(`${target.name} accepts JSON exactly at its ${target.limit}-byte ceiling`, async t => {
    const f = streamed(padded(target, target.limit), target.limit, { 'content-length': String(target.limit) });
    assert.deepEqual(await target.request(t, f.response), target.expected);
    assert.equal(f.cancelled, 0); assert.equal(f.body.locked, false);
  });
  for (const [name, headers] of [['no declared size', {}], ['underreported size', { 'content-length': '1' }]])
    test(`${target.name} rejects one streamed byte over the ceiling with ${name}`, async t => {
      const f = streamed(padded(target, target.limit + 1), target.limit, headers);
      await assert.rejects(target.request(t, f.response), target.limitError);
      assert.equal(f.cancelled, 1); assert.equal(f.body.locked, false);
    });
  test(`${target.name} rejects an oversized Content-Length before reading`, async t => {
    const f = streamed(padded(target, target.limit), target.limit, { 'content-length': String(target.limit + 1) });
    await assert.rejects(target.request(t, f.response), target.limitError);
    assert.equal(f.reads, 0); assert.equal(f.cancelled, 1); assert.equal(f.body.locked, false);
  });
  test(`${target.name} preserves its non-success HTTP error`, async t => {
    await assert.rejects(target.request(t, Response.json(target.body, { status: 503 })), target.httpError);
  });
  test(`${target.name} preserves a stream failure and releases its reader`, async t => {
    const failure = new Error('fixture connection reset');
    const body = new ReadableStream({ pull(controller) { controller.error(failure); } }, { highWaterMark: 0 });
    await assert.rejects(target.request(t, new Response(body)), error => error === failure);
    assert.equal(body.locked, false);
  });
}

for (const [method, body] of [['GET', undefined], ['POST', { name: 'new' }], ['PUT', { name: 'updated' }]])
  test(`Studio provisioning preserves ${method}, credentials and its 12-second deadline`, async t => {
    const config = { n8nNative: installation(t) }, deadlines = [], controller = new AbortController();
    t.mock.method(AbortSignal, 'timeout', ms => { deadlines.push(ms); return controller.signal; });
    const provider = createStudioProvider({ config, fetchImpl: async (url, options) => {
      assert.equal(url.pathname, '/api/v1/workflows/native-one');
      assert.equal(options.method, method); assert.equal(options.redirect, 'error');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.headers['X-N8N-API-KEY'], 'fictional-studio-http-token'.repeat(3));
      assert.equal(options.headers['content-type'], body === undefined ? undefined : 'application/json');
      assert.equal(options.body, body === undefined ? undefined : JSON.stringify(body));
      return Response.json({ id: 'native-one' });
    } });
    assert.deepEqual(await provider.api('/workflows/native-one', method, body), { id: 'native-one' });
    assert.deepEqual(deadlines, [12000]);
  });
test('Studio provisioning propagates its deadline cancellation', async t => {
  const controller = new AbortController(), expired = new DOMException('fixture deadline', 'TimeoutError');
  t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 12000); return controller.signal; });
  const provider = createStudioProvider({ config: { n8nNative: installation(t) }, fetchImpl: async (_url, options) => {
    controller.abort(expired); options.signal.throwIfAborted();
  } });
  await assert.rejects(provider.api('/workflows/native-one', 'PUT', {}), error => error === expired);
});
test('Studio provisioning rejects non-object JSON and preserves JSON syntax errors', async t => {
  const replies = [Response.json([]), new Response('{invalid')];
  const provider = createStudioProvider({ config: { n8nNative: installation(t) }, fetchImpl: async () => replies.shift() });
  await assert.rejects(provider.api('/workflows/native-one'), { code: 'INVALID_WORKFLOW', status: 409,
    message: 'n8n returned an invalid provisioning response. Retry this save.' });
  await assert.rejects(provider.api('/workflows/native-one'), SyntaxError);
});

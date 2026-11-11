import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioMcpHttp } from './studio-mcp-http.mjs';
import { streamedBodyOverflow } from './test-support/http-body-overflow.mjs';

const rpc = text => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_run', arguments: { text } } });
function fixture() {
  const calls = [];
  const handle = createStudioMcpHttp({
    session: { actor(headers) { if (!headers['x-test-authorized']) throw new Error('Denied'); return { role: 'owner' }; } },
    service: { async run(value) { calls.push(value); return value; } },
  });
  return { calls, handle, async send(chunks, headers = {}, method = 'POST') {
    let reads = 0, status, body;
    const req = { method, headers: { 'x-test-authorized': 'yes', 'content-type': 'application/json', ...headers },
      async *[Symbol.asyncIterator]() { reads++; yield* chunks; } };
    await handle(req, { writeHead(value) { status = value; }, end(value) { body = value && JSON.parse(value); } });
    return { status, body, reads };
  } };
}

test('MCP decodes split UTF-8 and normalizes string and Uint8Array body chunks', async () => {
  const f = fixture(), value = rpc('Ébavurer — 鋼 🔧'), bytes = Buffer.from(JSON.stringify(value));
  for (const chunks of [Array.from(bytes, byte => Buffer.from([byte])), [JSON.stringify(value)],
    [bytes.subarray(0, 12), new Uint8Array(bytes.subarray(12))]]) {
    const result = await f.send(chunks);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.result.structuredContent, value.params.arguments);
  }
  assert.deepEqual(f.calls, Array(3).fill(value.params.arguments));
});

test('MCP returns HTTP 413 for an unfinished chunked upload without dispatching a tool', async () => {
  const f = fixture();
  const response = await streamedBodyOverflow(f.handle, { headers: { 'x-test-authorized': 'yes' } });
  assert.equal(response.status, 413);
  assert.deepEqual(response.body, { error: 'STUDIO_INVALID_REQUEST' });
  assert.equal(response.destroyedBeforeResponse, false);
  assert.equal(response.headers.connection, 'close');
  assert.deepEqual(f.calls, []);
});

test('MCP accepts exactly 16 KiB and rejects Unicode byte overflow before service dispatch', async () => {
  const f = fixture(), limit = 16_384, overhead = Buffer.byteLength(JSON.stringify(rpc('')));
  const text = '€'.repeat(Math.floor((limit - overhead) / 3)) + 'x'.repeat((limit - overhead) % 3);
  const json = JSON.stringify(rpc(text));
  assert.equal(Buffer.byteLength(json), limit);
  assert.equal((await f.send([json])).status, 200);
  const overflow = await f.send([json, ' ']);
  assert.equal(overflow.status, 413);
  assert.deepEqual(overflow.body, { error: 'STUDIO_INVALID_REQUEST' });
  assert.deepEqual(f.calls, [{ text }]);
});

test('MCP admission failures do not consume the body', async () => {
  const f = fixture();
  for (const [headers, method, status] of [
    [{ 'x-test-authorized': '' }, 'POST', 403],
    [{ origin: 'https://foreign.example' }, 'POST', 403],
    [{ 'mcp-protocol-version': 'unsupported' }, 'POST', 400],
    [{}, 'GET', 405],
    [{ 'content-type': 'text/plain' }, 'POST', 415],
  ]) {
    const result = await f.send([JSON.stringify(rpc('ignored'))], headers, method);
    assert.equal(result.status, status); assert.equal(result.reads, 0);
  }
  assert.deepEqual(f.calls, []);
});

test('MCP keeps empty, malformed and failed body reads as invalid requests', async () => {
  const f = fixture();
  async function* broken() { yield Buffer.from('{'); throw new Error('Stream failed'); }
  for (const chunks of [[], ['{'], broken()]) {
    const result = await f.send(chunks);
    assert.equal(result.status, 400); assert.deepEqual(result.body, { error: 'STUDIO_INVALID_REQUEST' });
  }
  assert.deepEqual(f.calls, []);
});

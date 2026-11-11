import assert from 'node:assert/strict';
import test from 'node:test';
import { createNosNodeClient } from './nos-node-transport.mjs';

const limit = 2 * 1024 * 1024;
const payload = { text: 'Équipement 🛠' };
const limitError = { code: 'DKG_COMPONENT_UNCONFIRMED', status: 409, message: 'Node response exceeds the Studio limit.' };
const session = { accountId: 'fixture-account', controlPlaneUrl: 'http://127.0.0.1:1', secret: () => 'fictional-service-secret' };
const actor = { id: 'fixture-owner', role: 'owner', accountId: session.accountId };
const call = response => createNosNodeClient(session, actor, async () => response)('status');

function padded(size) {
  const json = Buffer.from(JSON.stringify({ kind: 'answer', status: 200, body: payload }));
  return Buffer.concat([json, Buffer.alloc(size - json.length, 0x20)]);
}
function streamed(bytes, headers = {}) {
  const split = bytes.indexOf(0xc3) + 1; // Split the UTF-8 encoding of É across chunks.
  const chunks = [bytes.subarray(0, split), bytes.subarray(split, limit), bytes.subarray(limit)].filter(chunk => chunk.length);
  let reads = 0, cancelled = 0;
  const body = new ReadableStream({
    pull(controller) { reads++; if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers }), body, get reads() { return reads; }, get cancelled() { return cancelled; } };
}

test('nOS node transport accepts exactly 2 MiB and decodes split UTF-8 before interpreting the envelope', async () => {
  const f = streamed(padded(limit), { 'content-length': String(limit) });
  assert.deepEqual(await call(f.response), payload);
  assert.equal(f.cancelled, 0); assert.equal(f.body.locked, false);
});
for (const [name, headers] of [['no declared size', {}], ['underreported size', { 'content-length': '1' }]])
  test(`nOS node transport rejects a streamed byte over 2 MiB with ${name}`, async () => {
    const f = streamed(padded(limit + 1), headers);
    await assert.rejects(call(f.response), limitError);
    assert.equal(f.cancelled, 1); assert.equal(f.body.locked, false);
  });
test('nOS node transport rejects an excessive Content-Length before reading', async () => {
  const f = streamed(padded(limit), { 'content-length': String(limit + 1) });
  await assert.rejects(call(f.response), limitError);
  assert.equal(f.reads, 0); assert.equal(f.cancelled, 1); assert.equal(f.body.locked, false);
});
test('nOS node transport preserves stream failures and releases the reader', async () => {
  const failure = new Error('fixture connection reset');
  const body = new ReadableStream({ pull(controller) { controller.error(failure); } }, { highWaterMark: 0 });
  await assert.rejects(call(new Response(body)), error => error === failure);
  assert.equal(body.locked, false);
});
test('nOS node transport preserves HTTP and node-envelope rejection codes', async () => {
  await assert.rejects(call(Response.json({ kind: 'answer', status: 200, body: payload }, { status: 403 })),
    { code: 'DKG_COMPONENT_UNCONFIRMED', status: 403, message: 'nOS did not authorize or confirm the node operation.' });
  await assert.rejects(call(Response.json({ kind: 'answer', status: 404, body: payload })),
    { code: 'DKG_COMPONENT_UNCONFIRMED', status: 404, message: 'The node did not confirm the operation.' });
  await assert.rejects(call(Response.json({ kind: 'pending' })),
    { code: 'DKG_COMPONENT_UNCONFIRMED', status: 409, message: 'Node outcome is unconfirmed. Retain the invocation identity.' });
});

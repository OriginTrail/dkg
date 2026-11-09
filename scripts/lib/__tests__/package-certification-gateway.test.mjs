import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureGateway } from '../package-certification/fixture-gateway.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
test('fixture gateway preserves HTTP streams and metadata, and reports upstream failure', async t => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = { method: request.method, url: request.url, header: request.headers['x-fixture'], body: Buffer.concat(chunks).toString() };
    response.writeHead(201, { 'x-upstream': 'fixture' });
    response.write('first '); response.end('second');
  });
  t.after(() => close(upstream));
  await listen(upstream);
  const gateway = createFixtureGateway({ upstreamPort: upstream.address().port, upstreamHost: '127.0.0.1' });
  t.after(() => close(gateway));
  await listen(gateway);
  const url = `http://127.0.0.1:${gateway.address().port}/rpc?fixture=1`;
  const response = await fetch(url, { method: 'PATCH', headers: { 'x-fixture': 'request' }, body: 'request bytes' });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-upstream'), 'fixture');
  assert.equal(await response.text(), 'first second');
  assert.deepEqual(observed, { method: 'PATCH', url: '/rpc?fixture=1', header: 'request', body: 'request bytes' });
  await close(upstream);
  assert.equal((await fetch(url)).status, 502);
});

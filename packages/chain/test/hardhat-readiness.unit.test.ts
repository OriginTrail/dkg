import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { waitForNode } from './hardhat-harness.js';

it('readiness requires a block number and cannot hang on an unresponsive RPC', async () => {
  let response: 'valid' | 'error' | 'hang' = 'valid';
  const server = createServer((_request, reply) => {
    if (response === 'hang') return;
    reply.setHeader('Content-Type', 'application/json');
    reply.end(JSON.stringify(response === 'valid' ? { result: '0x0' } : { error: { message: 'not ready' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listener');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    expect(await waitForNode(url, 1000)).toBe(true);
    response = 'error';
    expect(await waitForNode(url, 100)).toBe(false);
    response = 'hang';
    expect(await waitForNode(url, 100)).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

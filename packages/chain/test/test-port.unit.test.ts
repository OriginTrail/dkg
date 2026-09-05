import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { availableTestPort } from './test-port.js';

it('leaves an unrelated listener alive and chooses a different loopback port', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener unavailable');
    const selected = await availableTestPort(address.port);
    expect(selected).not.toBe(address.port);
    expect(server.listening).toBe(true);
    const probe = createServer();
    await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(selected, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

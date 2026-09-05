import { once } from 'node:events';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { startHardhatNode, waitForNode } from './hardhat-harness.js';

it('retries an occupied preferred port with a real ephemeral child bind and leaves its owner alive', async () => {
  const contender = createServer();
  await new Promise<void>((resolve) => contender.listen(0, '127.0.0.1', resolve));
  let child: Awaited<ReturnType<typeof startHardhatNode>> | undefined;
  try {
    const port = (contender.address() as { port: number }).port;
    child = await startHardhatNode(port);
    expect(new URL(child.rpcUrl).port).not.toBe(String(port));
    expect(contender.listening).toBe(true);
    expect(await waitForNode(child.rpcUrl, 1000)).toBe(true);
  } finally {
    if (child) { const closed = once(child.process, 'close'); child.process.kill('SIGTERM'); await closed; }
    await new Promise<void>((resolve) => contender.close(() => resolve()));
  }
});

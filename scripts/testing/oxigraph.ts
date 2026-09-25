import { createServer } from 'node:net';
import { startOxigraphServer, type StartOxigraphServerOptions } from '../../packages/cli/dist/daemon/oxigraph-server.js';
import { createOxigraphStoreOwnership } from '../../packages/cli/dist/daemon/oxigraph-store-ownership.js';

/**
 * Own port selection through the production launcher's verified child bind,
 * with the store ownership the managed layer would build for this binary.
 */
export async function startTestOxigraphServer(
  options: Omit<StartOxigraphServerOptions, 'port' | 'host' | 'storeOwnership'>,
) {
  for (let attempt = 0; ; attempt++) {
    const probe = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const selected = (probe.address() as { port: number }).port;
        probe.close((error) => error ? reject(error) : resolve(selected));
      });
    });
    // A store ownership serves one server, and a failed start closes it.
    const storeOwnership = createOxigraphStoreOwnership({
      binaryPath: options.binaryPath,
      location: options.location,
      log: options.log ?? (() => {}),
    });
    try {
      // startOxigraphServer verifies listener ownership and cleans its child on
      // failed startup. A contender cannot pass its readiness check.
      return await startOxigraphServer({ ...options, storeOwnership, host: '127.0.0.1', port });
    } catch (error) {
      if (attempt >= 2 || !/EADDRINUSE|Address already in use/i.test(String(error))) throw error;
    }
  }
}

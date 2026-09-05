import { createServer } from 'node:net';
import { startOxigraphServer, type StartOxigraphServerOptions } from '../../packages/cli/dist/daemon/oxigraph-server.js';

/** Own port selection through the production launcher's verified child bind. */
export async function startTestOxigraphServer(options: Omit<StartOxigraphServerOptions, 'port' | 'host'>) {
  for (let attempt = 0; ; attempt++) {
    const probe = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const selected = (probe.address() as { port: number }).port;
        probe.close((error) => error ? reject(error) : resolve(selected));
      });
    });
    try {
      // startOxigraphServer verifies listener ownership and cleans its child on
      // failed startup. A contender cannot pass its readiness check.
      return await startOxigraphServer({ ...options, host: '127.0.0.1', port });
    } catch (error) {
      if (attempt >= 2 || !/EADDRINUSE|Address already in use/i.test(String(error))) throw error;
    }
  }
}

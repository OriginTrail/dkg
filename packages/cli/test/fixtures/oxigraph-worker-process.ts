import { startOxigraphServer } from '../../src/daemon/oxigraph-server.js';
import { withStoreOwnership } from './oxigraph-server-real-fixture.js';

// Stand-in daemon worker: owns one managed Oxigraph through the production
// supervisor (direct launch, no memory limits), reports readiness, then idles
// until the test stops it (SIGTERM) or kills it the way the supervisor's
// liveness watchdog does (SIGKILL).
const [binaryPath, location, rawPort, mode] = process.argv.slice(2);
if (!binaryPath || !location || !rawPort) {
  throw new Error('expected binaryPath, location and port');
}

const handle = await startOxigraphServer(withStoreOwnership({
  binaryPath,
  location,
  port: Number(rawPort),
  readyTimeoutMs: 20_000,
  readyIntervalMs: 50,
  log: (message) => process.stderr.write(`${message}\n`),
  // `never-ready`: Oxigraph starts but ownership is never proven, as for a
  // store that is still replaying its write-ahead log.
  ...(mode === 'never-ready' ? { io: { findListenOwnerPid: async () => null } } : {}),
}));
process.once('SIGTERM', () => {
  void handle.stop().finally(() => process.exit(0));
});
process.stdout.write(`${JSON.stringify({ ready: handle.queryEndpoint })}\n`);
setInterval(() => {}, 60_000);

import { startOxigraphServer } from '../../src/daemon/oxigraph-server.js';

// Stand-in daemon worker: owns one managed Oxigraph through the production
// supervisor (direct launch, no memory limits), reports readiness, then idles
// until the test stops it (SIGTERM) or kills it the way the supervisor's
// liveness watchdog does (SIGKILL).
const [binaryPath, location, rawPort] = process.argv.slice(2);
if (!binaryPath || !location || !rawPort) {
  throw new Error('expected binaryPath, location and port');
}

const handle = await startOxigraphServer({
  binaryPath,
  location,
  port: Number(rawPort),
  readyTimeoutMs: 20_000,
  readyIntervalMs: 50,
  log: (message) => process.stderr.write(`${message}\n`),
});
process.once('SIGTERM', () => {
  void handle.stop().finally(() => process.exit(0));
});
process.stdout.write(`${JSON.stringify({ ready: handle.queryEndpoint })}\n`);
setInterval(() => {}, 60_000);

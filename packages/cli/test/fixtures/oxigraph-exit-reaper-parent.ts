import { writeFileSync } from 'node:fs';
import { startOxigraphServer } from '../../src/daemon/oxigraph-server.js';

const [binaryPath, location, rawPort, pidFile] = process.argv.slice(2);
if (!binaryPath || !location || !rawPort || !pidFile) {
  throw new Error('expected binaryPath, location, port and pidFile');
}
const port = Number(rawPort);

// Keep readiness pending after the real stand-in has bound. The supervisor's
// exit guard is installed during this window, before startOxigraphServer has
// returned a handle to any caller.
void startOxigraphServer({
  binaryPath,
  location,
  port,
  autoReadyBaseTimeoutMs: 30_000,
  readyIntervalMs: 100,
  io: { findListenOwnerPid: async () => null },
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

const deadline = Date.now() + 10_000;
for (;;) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/pid`);
    if (response.ok) {
      writeFileSync(pidFile, await response.text(), 'utf8');
      // process.exit() invokes the synchronous guard; the child must receive
      // SIGTERM even though readiness has not completed.
      process.exit(0);
    }
  } catch {
    // Child is still starting.
  }
  if (Date.now() >= deadline) throw new Error('stand-in did not bind');
  await new Promise((resolve) => setTimeout(resolve, 25));
}

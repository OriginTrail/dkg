import { defaultDockerRunner } from '../../src/daemon/blazegraph-docker.js';
import { executeHardenMigration } from '../../src/daemon/blazegraph-harden.js';
import { crashDocker, crashVerifier, CRASH_NAME, CRASH_NAMESPACE } from '../_helpers/harden-crash-docker.js';
const home = process.argv[2]!, beforeExport = process.argv[3] === 'before-export';
const real = process.argv[3] === 'real';
const captured = real ? JSON.parse(process.argv[4]!) : {};
const runner = real ? defaultDockerRunner() : crashDocker(home).runner;
await executeHardenMigration({ containerName: CRASH_NAME, namespace: CRASH_NAMESPACE, migrationDir: home, dkgHome: home,
  ...captured,
  docker: { async run(args, options) {
    const result = await runner.run(args, options);
    if (beforeExport ? args[0] === 'volume' && args[1] === 'inspect' : args[0] === 'run' && args[1] === '-d') {
      process.send?.({ replacementCreated: !beforeExport, ownerPid: process.pid });
      await new Promise<void>(() => {});
    }
    return result;
  } }, fetch: real ? globalThis.fetch : crashVerifier, freeDiskBytes: async () => 1e12, log() {}, readyTimeoutMs: 100, readyIntervalMs: 1,
});

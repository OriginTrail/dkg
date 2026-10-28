/** Child-process fixture: use real orchestration with a controlled launcher. */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapDevnet } from '../bootstrap-devnet-runtime.js';

const devnetDir = process.env.DEVNET_DIR!;
const mode = process.env.FAILURE_MODE;
await bootstrapDevnet({
  devnetDir, nodeNum: '2', numNodes: '2', timeoutMs: 100,
  apiPortBase: '19201', libp2pPortBase: '20001',
  launch: async () => {
    writeFileSync(join(devnetDir, 'marker-at-launch.json'), readFileSync(join(devnetDir, '.playwright-managed')));
    if (mode === 'launch-failure') throw new Error('controlled launch failure');
    const nodeDir = join(devnetDir, 'node2');
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore', env: { ...process.env, DKG_HOME: nodeDir },
    });
    writeFileSync(join(nodeDir, 'daemon.pid'), String(worker.pid));
    worker.unref();
    console.log('controlled launch complete');
    if (mode === 'cancelled') {
      await new Promise<void>(() => { setInterval(() => {}, 1000); });
    }
    return { exitCode: 9 };
  },
}).catch(error => {
  console.error('[playwright] devnet bootstrap failed:', error);
  process.exit(1);
});

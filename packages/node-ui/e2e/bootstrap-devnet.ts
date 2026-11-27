/** Bootstrap runs before Vite reads api.port; global setup alone cannot order it. */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapDevnet } from './bootstrap-devnet-runtime.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const nodeNum = process.env.DEVNET_NODE || process.env.UI_NODE_ID || '1';
const options = {
  devnetDir: resolve(REPO_ROOT, '.devnet'),
  nodeNum,
  numNodes: process.env.PLAYWRIGHT_DEVNET_NUM_NODES || String(parseInt(nodeNum, 10) || 1),
  // Four-node mesh setup retains the existing 240s readiness budget.
  timeoutMs: parseInt(process.env.PLAYWRIGHT_DEVNET_TIMEOUT_MS || '240000', 10),
  apiPortBase: process.env.API_PORT_BASE || process.env.PLAYWRIGHT_DEVNET_API_PORT_BASE || '19201',
  libp2pPortBase: process.env.LIBP2P_PORT_BASE || process.env.PLAYWRIGHT_DEVNET_LIBP2P_PORT_BASE || '20001',
};

function launch(): Promise<{ exitCode: number }> {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn('bash', [resolve(REPO_ROOT, 'scripts/devnet.sh'), 'start',
      String(parseInt(options.numNodes, 10) || parseInt(nodeNum, 10) || 1)], {
      cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, DEVNET_DIR: options.devnetDir,
        API_PORT_BASE: options.apiPortBase, LIBP2P_PORT_BASE: options.libp2pPortBase },
    });
    child.on('error', rejectLaunch);
    // A post-boot assertion can fail while daemons are healthy. Orchestration
    // always probes API readiness and the full mesh before accepting the boot.
    child.on('exit', code => resolveLaunch({ exitCode: typeof code === 'number' ? code : 1 }));
  });
}

bootstrapDevnet({ ...options, launch }).catch(err => {
  console.error('[playwright] devnet bootstrap FAILED:', err?.stack || err);
  process.exit(1);
});

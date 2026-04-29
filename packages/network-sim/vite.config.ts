import { defineConfig, Plugin, createLogger } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { simEngine } from './src/server/sim-engine';

const SIM_TARGET = process.env.SIM_TARGET ?? 'devnet'; // 'devnet' | 'testnet'

const DEVNET_DIR = path.resolve(__dirname, '../../.devnet');
const EVM_DEPLOYMENTS = path.resolve(__dirname, '../evm-module/deployments/localhost');
const DEVNET_NUM_NODES = 6;
const DEVNET_API_PORT_BASE = 9201;
const DKG_HOME = process.env.DKG_HOME ?? path.join(os.homedir(), '.dkg');

function readTestnetNodes(): { id: number; name: string; apiPort: number; listenPort: number; nodeRole: string }[] {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DKG_HOME, 'config.json'), 'utf-8'));
    return [{
      id: 1,
      name: cfg.name ?? 'testnet-node',
      apiPort: cfg.apiPort ?? 9200,
      listenPort: cfg.listenPort ?? 0,
      nodeRole: cfg.nodeRole ?? 'edge',
    }];
  } catch {
    return [];
  }
}

function networkDiscovery(): Plugin {
  return {
    name: 'network-discovery',
    configureServer(server) {
      server.middlewares.use('/devnet/config', async (_req, res) => {
        try {
          if (SIM_TARGET === 'testnet') {
            const nodes = readTestnetNodes();
            let chainRpc = '';
            let hubAddress = '';
            // Operator overrides come from ~/.dkg/config.json#chain. Anything
            // they leave out (which is everything on a fresh `dkg openclaw
            // setup` post-PR-322) falls back to the shipped network defaults
            // in network/testnet.json — mirroring resolveChainConfig in
            // packages/cli/src/config.ts so this devtool doesn't break for
            // freshly bootstrapped nodes that intentionally omit `chain` to
            // let hub/RPC rotations propagate.
            try {
              const cfg = JSON.parse(fs.readFileSync(path.join(DKG_HOME, 'config.json'), 'utf-8'));
              chainRpc = cfg.chain?.rpcUrl ?? '';
              hubAddress = cfg.chain?.hubAddress ?? '';
            } catch { /* ignore */ }
            if (!chainRpc || !hubAddress) {
              try {
                const networkPath = path.resolve(__dirname, '../../network/testnet.json');
                const network = JSON.parse(fs.readFileSync(networkPath, 'utf-8'));
                chainRpc = chainRpc || network.chain?.rpcUrl || '';
                hubAddress = hubAddress || network.chain?.hubAddress || '';
              } catch { /* ignore */ }
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              nodes,
              contracts: {},
              hubAddress,
              chainRpc,
              network: 'testnet',
            }));
            return;
          }

          // Devnet mode
          const nodes: Record<string, unknown>[] = [];
          for (let i = 1; i <= DEVNET_NUM_NODES; i++) {
            const dir = path.join(DEVNET_DIR, `node${i}`);
            try {
              const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
              let wallets: unknown = null;
              try {
                wallets = JSON.parse(fs.readFileSync(path.join(dir, 'wallets.json'), 'utf-8'));
              } catch { /* no wallets file */ }
              nodes.push({ id: i, ...config, wallets });
            } catch { /* node dir not found */ }
          }

          const contracts: Record<string, string> = {};
          try {
            for (const file of fs.readdirSync(EVM_DEPLOYMENTS)) {
              if (file.endsWith('.json')) {
                const data = JSON.parse(fs.readFileSync(path.join(EVM_DEPLOYMENTS, file), 'utf-8'));
                if (data.address) contracts[file.replace('.json', '')] = data.address;
              }
            }
          } catch { /* deployment dir not found */ }

          let hubAddress = '';
          try {
            hubAddress = fs.readFileSync(path.join(DEVNET_DIR, 'hardhat/hub_address'), 'utf-8').trim();
          } catch { /* no hub address */ }

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            nodes,
            contracts,
            hubAddress,
            chainRpc: 'http://127.0.0.1:8545',
            network: 'devnet',
          }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    },
  };
}

const logger = createLogger();
const originalWarn = logger.warn.bind(logger);
const originalError = logger.error.bind(logger);
logger.warn = (msg, opts) => {
  if (msg.includes('http proxy error') && msg.includes('ECONNREFUSED')) return;
  originalWarn(msg, opts);
};
logger.error = (msg, opts) => {
  if (msg.includes('http proxy error') && msg.includes('ECONNREFUSED')) return;
  originalError(msg, opts);
};

function readDevnetToken(): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(DEVNET_DIR, 'node1', 'auth.token'), 'utf-8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.length > 0 && !t.startsWith('#')) return t;
    }
  } catch { /* token file not yet created */ }
  return undefined;
}

const devnetAuthToken = readDevnetToken();

function makeProxyEntry(target: string, nodeId: number) {
  return {
    target,
    rewrite: (p: string) => p.replace(`/node/${nodeId}`, ''),
    configure: (proxy: { on: (event: string, handler: (...args: unknown[]) => void) => void }) => {
      if (devnetAuthToken) {
        proxy.on('proxyReq', (proxyReq: { setHeader: (name: string, value: string) => void }) => {
          proxyReq.setHeader('Authorization', `Bearer ${devnetAuthToken}`);
        });
      }
      proxy.on('error', (_err: unknown, _req: unknown, res: { writeHead?: (code: number, headers: Record<string, string>) => void; end?: (body: string) => void }) => {
        if (res.writeHead && res.end) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Node offline' }));
        }
      });
    },
  };
}

const nodeProxies: Record<string, object> = {};
if (SIM_TARGET === 'testnet') {
  const testnetNodes = readTestnetNodes();
  for (const node of testnetNodes) {
    nodeProxies[`/node/${node.id}/api`] = makeProxyEntry(
      `http://127.0.0.1:${node.apiPort}`,
      node.id,
    );
  }
  console.log(`[sim] Testnet mode — proxying ${testnetNodes.length} node(s)`);
} else {
  for (let i = 1; i <= DEVNET_NUM_NODES; i++) {
    nodeProxies[`/node/${i}/api`] = makeProxyEntry(
      `http://127.0.0.1:${DEVNET_API_PORT_BASE + i - 1}`,
      i,
    );
  }
  console.log(`[sim] Devnet mode — proxying ${DEVNET_NUM_NODES} nodes`);
}

export default defineConfig({
  customLogger: logger,
  plugins: [react(), networkDiscovery(), simEngine()],
  server: {
    port: 3000,
    proxy: nodeProxies,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

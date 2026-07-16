import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

function readTokenFile(path: string): string {
  try {
    const raw = readFileSync(path, 'utf-8');
    return raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))[0] || '';
  } catch { return ''; }
}

function readDkgConfig() {
  // Devnet takes priority over ~/.dkg only when explicitly requested.
  // `scripts/devnet.sh ui start` exports DEVNET_NODE=$UI_NODE_ID, so
  // operators can still point at node5 by setting UI_NODE_ID=5 before
  // invoking the wrapper (or DEVNET_NODE directly for `pnpm dev:ui`).
  // Without that explicit opt-in, stale `.devnet/node1` files must not
  // shadow the real local node in ~/.dkg.
  const devnetNodeNum = process.env.DEVNET_NODE || process.env.UI_NODE_ID;
  if (devnetNodeNum) {
    const devnetDir = resolve(__dirname, '../../.devnet', `node${devnetNodeNum}`);
    const portFile = join(devnetDir, 'api.port');
    if (!existsSync(portFile)) {
      throw new Error(
        `[vite] DEVNET_NODE/UI_NODE_ID requested devnet node${devnetNodeNum}, ` +
        `but ${portFile} does not exist. Start that devnet node or unset the env var to use ~/.dkg.`,
      );
    }
    const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10) || 9201;
    const token = readTokenFile(join(devnetDir, 'auth.token'));
    console.log(`[vite] Using devnet node${devnetNodeNum} on port ${port}`);
    return { port, token };
  }

  // Fall back to ~/.dkg (testnet / production node)
  const dkgDir = join(homedir(), '.dkg');
  let port = 9200;
  let token = '';
  try {
    if (existsSync(join(dkgDir, 'api.port'))) {
      port = parseInt(readFileSync(join(dkgDir, 'api.port'), 'utf-8').trim(), 10) || 9200;
    }
  } catch {}
  token = readTokenFile(join(dkgDir, 'auth.token'));
  console.log(`[vite] Using node on port ${port} (from ~/.dkg)`);
  return { port, token };
}

const { port, token } = readDkgConfig();

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'inject-dkg-token',
      apply: 'serve',
      transformIndexHtml(html) {
        if (!token) return html;
        return html.replace('</head>', `<script>window.__DKG_TOKEN__=${JSON.stringify(token)}</script></head>`);
      },
    },
  ],
  root: 'src/ui',
  base: '/ui/',
  build: {
    outDir: '../../dist-ui',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${port}`,
    },
  },
});

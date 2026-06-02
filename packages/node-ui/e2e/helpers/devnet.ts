import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

export interface DevnetNodeConfig {
  num: number;
  apiPort: number;
  authToken: string;
  home: string;
}

function readToken(path: string): string {
  try {
    return (
      readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith('#')) ?? ''
    );
  } catch {
    return '';
  }
}

/** Returns devnet node config when `.devnet/node{N}` exists, else null. */
export function readDevnetNode(num = 1): DevnetNodeConfig | null {
  const home = join(REPO_ROOT, '.devnet', `node${num}`);
  const portFile = join(home, 'api.port');
  if (!existsSync(portFile)) return null;
  const apiPort = parseInt(readFileSync(portFile, 'utf8').trim(), 10) || 9201;
  return {
    num,
    apiPort,
    authToken: readToken(join(home, 'auth.token')),
    home,
  };
}

export function isDevnetAvailable(num = 1): boolean {
  const node = readDevnetNode(num);
  if (!node) return false;
  try {
    execSync(`curl -sf --max-time 2 http://127.0.0.1:${node.apiPort}/api/status -o /dev/null`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export async function devnetApiFetch(
  path: string,
  init: RequestInit & { nodeNum?: number } = {},
): Promise<Response> {
  const node = readDevnetNode(init.nodeNum ?? 1);
  if (!node) {
    throw new Error(`Devnet node${init.nodeNum ?? 1} not running`);
  }
  // UI alias paths that the daemon exposes under a different route.
  const daemonPath = path === '/api/context-graphs' ? '/api/context-graph/list' : path;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  };
  if (node.authToken) {
    headers.Authorization = `Bearer ${node.authToken}`;
  }
  const { nodeNum: _n, ...rest } = init;
  return fetch(`http://127.0.0.1:${node.apiPort}${daemonPath}`, { ...rest, headers });
}

export async function waitForDevnetStatus(
  nodeNum = 1,
  timeoutMs = 30_000,
  options: { requireIdentity?: boolean } = {},
): Promise<{ identityId: string; synced: boolean }> {
  const requireIdentity = options.requireIdentity ?? true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await devnetApiFetch('/api/status', { nodeNum });
      if (res.ok) {
        const json = (await res.json()) as { identityId?: string; synced?: boolean };
        if (!requireIdentity || (json.identityId && BigInt(json.identityId) > 0n)) {
          return { identityId: json.identityId ?? '0', synced: !!json.synced };
        }
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Devnet node${nodeNum} did not become ready within ${timeoutMs}ms`);
}

/** Skip helper for devnet-only specs — call at start of test. */
export function skipUnlessDevnet(test: { skip: (condition: boolean, description: string) => void }, nodeNum = 1) {
  test.skip(!isDevnetAvailable(nodeNum), `Devnet node${nodeNum} not running — start with ./scripts/devnet.sh start 6`);
}

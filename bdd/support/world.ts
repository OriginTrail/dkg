/**
 * Shared "World" for the BDD pilot's @devnet steps.
 *
 * Pure Node (global fetch + node:fs) — no test framework imports, so it can be
 * reused by any step file. Mirrors the connection + gating logic that
 * devnet/v10-*-flows do inline (readNodeConfig / readDevnetToken / ensureIdentity
 * / postJson), but exported so the Gherkin step layer can call it directly.
 *
 * Kept deliberately faithful to devnet/v10-end-to-end/automated.test.ts:
 *   - apiPort comes from `config.apiPort`
 *   - auth.token may contain `#` comment lines; take the first non-empty,
 *     non-comment line (matches readNodeConfig at lines 122-129)
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const DEVNET_DIR = resolve(REPO_ROOT, '.devnet');

export const CONTEXT_GRAPH = 'devnet-test';

export interface DevnetNode {
  num: number;
  apiPort: number;
  authToken: string;
  api: string;
}

export interface DevnetProbe {
  available: boolean;
  reason?: string;
  node?: DevnetNode;
}

/** First non-empty, non-comment line — matches the harness's auth.token parsing. */
function readAuthToken(home: string): string {
  const path = join(home, 'auth.token');
  if (!existsSync(path)) return '';
  return (
    readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('#')) ?? ''
  );
}

/**
 * Cheap, synchronous gate — does a devnet appear to be provisioned on disk?
 * Used to decide whether to include or skip the @devnet scenarios. The async
 * health check (probeStatus) confirms the node is actually answering.
 */
export function detectDevnet(num = 1): DevnetProbe {
  if (!existsSync(DEVNET_DIR)) return { available: false, reason: `no ${DEVNET_DIR}` };
  const home = join(DEVNET_DIR, `node${num}`);
  const cfgPath = join(home, 'config.json');
  if (!existsSync(cfgPath)) return { available: false, reason: `no ${cfgPath}` };

  let apiPort: number | undefined;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { apiPort?: number };
    apiPort = cfg.apiPort;
  } catch (e) {
    return { available: false, reason: `unreadable config: ${(e as Error).message}` };
  }
  if (!apiPort) return { available: false, reason: 'no apiPort in node config' };

  return {
    available: true,
    node: { num, apiPort, authToken: readAuthToken(home), api: `http://127.0.0.1:${apiPort}` },
  };
}

function headers(node: DevnetNode): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (node.authToken) h.authorization = `Bearer ${node.authToken}`;
  return h;
}

export interface HttpResult {
  status: number;
  body: any;
}

export async function postJson(node: DevnetNode, path: string, body: unknown): Promise<HttpResult> {
  const res = await fetch(`${node.api}${path}`, {
    method: 'POST',
    headers: headers(node),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await parse(res) };
}

export async function getJson(node: DevnetNode, path: string): Promise<HttpResult> {
  const res = await fetch(`${node.api}${path}`, { headers: headers(node) });
  return { status: res.status, body: await parse(res) };
}

async function parse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Async health check — true if /api/status answers 2xx. */
export async function probeStatus(node: DevnetNode): Promise<boolean> {
  try {
    const { status } = await getJson(node, '/api/status');
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

/**
 * Idempotent identity registration — mirrors ensureIdentity() in the devnet
 * harness. The chain-publish step needs the node to have an on-chain identity;
 * the bootstrap script normally provides it, this is a safety net. Returns the
 * identityId (0n if the node never registers in time).
 */
export async function ensureIdentity(node: DevnetNode, timeoutMs = 30_000): Promise<bigint> {
  const current = await readIdentity(node);
  if (current > 0n) return current;
  await postJson(node, '/api/identity/ensure', {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = await readIdentity(node);
    if (id > 0n) return id;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return 0n;
}

async function readIdentity(node: DevnetNode): Promise<bigint> {
  try {
    const { body } = await getJson(node, '/api/status');
    return BigInt(body?.identityId ?? 0);
  } catch {
    return 0n;
  }
}

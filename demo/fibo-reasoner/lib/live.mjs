// --live path: drive the real rc.17 /api/knowledge-assets lifecycle against a
// running daemon. Best-effort by design — every call is wrapped so a flaky
// devnet degrades to a warning, never an abort. The offline narrative is the
// star; this proves the same story lands on a real node when one is healthy.
//
// Lifecycle used (all confirmed in packages/cli/src/daemon/routes/knowledge-assets.ts):
//   POST /api/knowledge-assets                      create + auto-finalize (→ WM)
//   POST /api/knowledge-assets  {alsoShareSwm:true} create + promote      (→ SWM)
//   POST /api/knowledge-assets/:name/vm/publish     mint on chain         (→ VM)
//   dkg query <cg> -q <sparql> --include-shared-memory   read it back

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SELF_DIR, '..', '..', '..');
const LOCAL_CLI = join(REPO_ROOT, 'packages/cli/dist/cli.js');

export async function resolveAuth() {
  const dkgHome = process.env.DKG_HOME || join(homedir(), '.dkg');
  let port;
  try {
    port = parseInt((await readFile(join(dkgHome, 'api.port'), 'utf8')).trim(), 10);
  } catch {
    throw new Error(`No daemon reachable: cannot read ${join(dkgHome, 'api.port')} (is \`dkg start\` running?)`);
  }
  if (!Number.isFinite(port)) throw new Error(`Bad port in ${join(dkgHome, 'api.port')}`);

  let token = process.env.DKG_API_TOKEN || null;
  if (!token) {
    for (const p of [join(dkgHome, 'auth.token'), join(dkgHome, 'auth', 'token')]) {
      try {
        const t = (await readFile(p, 'utf8')).trim();
        if (t) { token = t; break; }
      } catch { /* auth may be disabled — fine */ }
    }
  }
  return { baseUrl: `http://127.0.0.1:${port}`, token, dkgHome };
}

function runCli(args) {
  const useLocal = existsSync(LOCAL_CLI);
  const cmd = useLocal ? 'node' : 'dkg';
  const full = useLocal ? [LOCAL_CLI, ...args] : args;
  const proc = spawnSync(cmd, full, { encoding: 'utf8' });
  return { exit: proc.status ?? 1, stdout: proc.stdout || '', stderr: proc.stderr || '' };
}

async function apiPost(auth, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(`${auth.baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  return { ok: res.ok, status: res.status, body: json };
}

// Create (or reuse) the context graph that holds the demo's KAs. Honours
// FIBO_DEMO_CG when set, otherwise creates one and best-effort parses the
// daemon-resolved, author-namespaced id from the CLI output.
export async function ensureContextGraph(nameInput) {
  if (process.env.FIBO_DEMO_CG) return { contextGraphId: process.env.FIBO_DEMO_CG, created: false };
  const create = runCli(['context-graph', 'create', nameInput]);
  if (create.exit !== 0) {
    throw new Error(`\`context-graph create\` failed (exit ${create.exit}): ${create.stderr.trim() || create.stdout.trim()}`);
  }
  const m = create.stdout.match(/(0x[0-9a-fA-F]{6,}\/[\w.-]+)/) || create.stdout.match(/did:dkg:context-graph:([\w.\/-]+)/);
  const contextGraphId = m ? (m[1] ?? m[0]) : nameInput;
  runCli(['context-graph', 'register', contextGraphId]); // idempotent; ignore result
  return { contextGraphId, created: true };
}

// One Working-Memory KA per ownership fact (create with quads auto-finalizes).
export function writeWorkingMemory(auth, contextGraphId, name, quads) {
  return apiPost(auth, '/api/knowledge-assets', { contextGraphId, name, quads });
}

// The inference KA: derived control triples + provenance, promoted to SWM in
// one atomic create (alsoShareSwm).
export function shareToSwm(auth, contextGraphId, name, quads) {
  return apiPost(auth, '/api/knowledge-assets', { contextGraphId, name, quads, alsoShareSwm: true });
}

// Anchor the inference to Verifiable Memory.
export function publishToVm(auth, contextGraphId, name) {
  return apiPost(auth, `/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`, { contextGraphId });
}

// Read the verified inference back, including the shared-memory layer.
export function querySparql(contextGraphId, sparql) {
  const res = runCli(['query', contextGraphId, '-q', sparql, '--include-shared-memory']);
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch { /* leave raw */ }
  return { exit: res.exit, parsed, raw: res.stdout, stderr: res.stderr };
}

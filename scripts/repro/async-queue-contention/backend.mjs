// Backend and build plumbing of the async queue contention benchmark: the dist loader, the loopback guard, the namespace lifecycle and the
// run provenance. Nothing is imported at module top level (the product comes from packages/*/dist via loadDist), so this file is import-safe.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const EXIT_REFUSED_BACKEND = 3;

// The built product the benchmark measures; a plain script cannot resolve the workspace packages by bare specifier.
const DIST = {
  storage: 'storage/dist/index.js', core: 'core/dist/index.js', pub: 'publisher/dist/index.js',
  utils: 'publisher/dist/async-promote-queue-utils.js', binding: 'publisher/dist/promote-recovery-binding.js', intent: 'publisher/dist/promote-operation-intent.js',
  preflight: 'agent/dist/context-graph-write-preflight.js', resolve: 'agent/dist/dkg-agent-cg-resolve.js', worker: 'cli/dist/daemon/worker/async-promote-worker.js',
};

export async function loadDist(root = REPO_ROOT) {
  const out = {};
  for (const [name, rel] of Object.entries(DIST)) {
    const file = path.join(root, 'packages', rel);
    if (!existsSync(file)) throw new Error(`packages/${rel.split('/')[0]}/dist is missing; run pnpm run build:packages`);
    out[name] = await import(pathToFileURL(file).href);
  }
  return out;
}

/** The benchmark creates and drops namespaces and generates heavy load: it refuses any backend that is not on this machine. */
export function resolveEndpoint({ url = process.env.BLAZEGRAPH_TEST_URL, allowRemote = false }) {
  const refuse = (why) => Object.assign(new Error(why), { exitCode: EXIT_REFUSED_BACKEND });
  if (!url) throw refuse('a Blazegraph SPARQL URL is required (--blazegraph-url or BLAZEGRAPH_TEST_URL), e.g. http://127.0.0.1:9999/bigdata/namespace/kb/sparql');
  let u;
  try { u = new URL(url); } catch { throw refuse(`not a URL: ${url}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw refuse(`the backend must be an http(s) URL: ${url}`);
  if (!allowRemote && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw refuse(`refusing the non-loopback backend ${u.hostname}: the benchmark creates and drops namespaces and loads the server; pass --allow-remote-backend only for a Blazegraph you own`);
  }
  return u.toString();
}

/** Creates a fresh namespace, runs fn({ sparqlUrl, namespace }) and drops the namespace (also on Ctrl-C) unless keep. */
export async function withNamespace(storage, endpoint, { keep = false, prefix = 'aqc' } = {}, fn) {
  const mgr = new storage.BlazegraphNamespaceManager({ namespaceApiUrl: storage.blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint), requestTimeoutMs: 30_000 });
  const namespace = `${prefix}${randomBytes(3).toString('hex')}`;
  const handles = await mgr.acquireMany([namespace]);
  let dropped = keep;
  const drop = async () => {
    if (dropped) return;
    dropped = true;
    try { await mgr.disposeAll(handles, { reconcileAttempts: 3 }); } catch (e) { console.error(`[aqc] could not drop namespace ${namespace}: ${e?.message ?? e}; drop it by hand`); }
  };
  const onSignal = () => { drop().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try { return await fn({ sparqlUrl: handles[0].sparqlUrl, namespace }); } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await drop();
  }
}

// ---------------------------------------------------------------- provenance
export function gitInfo() {
  const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try { return { sha: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=no') !== '' }; } catch { return { sha: null, dirty: null }; }
}

function newestMtime(dir, ext) {
  let max = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (ext.test(e.name)) max = Math.max(max, statSync(path.join(d, e.name)).mtimeMs);
    }
  };
  if (existsSync(dir)) walk(dir);
  return max;
}

/** Warning only (a turbo cache restore can give false positives): a package source newer than its newest dist file means a stale build is being measured. */
export function distStaleSuspected(root = REPO_ROOT) {
  return ['core', 'storage', 'publisher', 'agent', 'cli'].some((pkg) => {
    const base = path.join(root, 'packages', pkg);
    return newestMtime(path.join(base, 'src'), /\.tsx?$/) > newestMtime(path.join(base, 'dist'), /\.js$/);
  });
}

/** scriptFiles: absolute paths. The hash is over their bytes in sorted order: base and candidate runs must show the same value. */
export function provenance(scriptFiles) {
  const hash = createHash('sha256');
  for (const f of [...scriptFiles].sort()) hash.update(path.relative(REPO_ROOT, f)).update('\0').update(readFileSync(f)).update('\0');
  return {
    git: gitInfo(), scriptSha256: hash.digest('hex'), distStaleSuspected: distStaleSuspected(), node: process.version,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('DKG_STORE_'))),
  };
}

#!/usr/bin/env node
/**
 * admission-probe.mjs — load probe for the DKG daemon's HTTP admission control
 * (PR #1209). Fires a concurrent burst at a NON-exempt endpoint (default
 * POST /api/query) plus concurrent probes at the EXEMPT liveness path
 * (/api/status), then a single recovery request — and reads the daemon's own
 * `/api/status.admission` block before/after so you can see the effective cap
 * and how many requests were shed.
 *
 * This is an operator/CI-soak tool, NOT a pass/fail gate — it reports numbers.
 * Deterministic behaviour is covered by the unit + real-node tests.
 *
 * Usage:
 *   node scripts/load/admission-probe.mjs [options]
 *     --base <url>            daemon base URL            (default http://127.0.0.1:9200)
 *     --token <bearer>        auth token (overrides --token-file)
 *     --token-file <path>     file to read the token from (default ~/.dkg/auth.token)
 *     --concurrency, -c <n>   non-exempt burst size      (default 50)
 *     --status <n>            concurrent /api/status probes during the burst (default 12)
 *     --path <p>              non-exempt endpoint        (default /api/query)
 *     --query <sparql>        SPARQL for /api/query      (default a trivial SELECT)
 *
 * To actually exercise shedding on a node, pin a low cap first, e.g.:
 *   DKG_MAX_INFLIGHT=3 dkg start   # then run this probe
 */
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:9200' },
    token: { type: 'string' },
    'token-file': { type: 'string', default: join(homedir(), '.dkg', 'auth.token') },
    concurrency: { type: 'string', short: 'c', default: '50' },
    status: { type: 'string', default: '12' },
    path: { type: 'string', default: '/api/query' },
    query: { type: 'string', default: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1' },
  },
});

const base = values.base.replace(/\/$/, '');
const C = Number(values.concurrency);
const SC = Number(values.status);

function loadToken() {
  if (values.token) return values.token;
  try {
    return readFileSync(values['token-file'], 'utf8')
      .split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
  } catch {
    return '';
  }
}
const token = loadToken();
const authHdr = token ? { Authorization: `Bearer ${token}` } : {};
const tally = (arr) => arr.reduce((a, s) => { a[s] = (a[s] || 0) + 1; return a; }, {});

async function getAdmission() {
  try {
    const r = await fetch(`${base}/api/status`, { headers: authHdr });
    if (!r.ok) return null;
    return (await r.json()).admission ?? null;
  } catch {
    return null;
  }
}

function fireNonExempt() {
  return fetch(`${base}${values.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHdr },
    body: JSON.stringify({ sparql: values.query }),
  })
    .then((r) => ({ status: r.status, retryAfter: r.headers.get('retry-after') }))
    .catch((e) => ({ status: 0, retryAfter: null, err: String(e) }));
}

const before = await getAdmission();

const [burst, statuses] = await Promise.all([
  Promise.all(Array.from({ length: C }, fireNonExempt)),
  Promise.all(Array.from({ length: SC }, () =>
    fetch(`${base}/api/status`, { headers: authHdr }).then((r) => r.status).catch(() => 0))),
]);

const recovery = await fireNonExempt();
const after = await getAdmission();

const shed = burst.filter((r) => r.status === 503);
console.log(`\nadmission-probe → ${base}${values.path}`);
console.log(`  burst(${C}) statuses:`, JSON.stringify(tally(burst.map((r) => r.status))));
console.log(`    admitted(200): ${burst.filter((r) => r.status === 200).length}   shed(503): ${shed.length}`);
console.log(`    every 503 has Retry-After: ${shed.length > 0 && shed.every((r) => r.retryAfter != null)} (sample="${shed[0]?.retryAfter ?? 'n/a'}")`);
console.log(`  exempt /api/status(${SC}):`, JSON.stringify(tally(statuses)), `→ all 200: ${statuses.every((s) => s === 200)}`);
console.log(`  recovery request after burst: ${recovery.status}`);
if (before && after) {
  console.log(`  /api/status admission: cap(max)=${after.max}  inFlight=${after.inFlight}  rejectedTotal ${before.rejectedTotal}→${after.rejectedTotal} (+${after.rejectedTotal - before.rejectedTotal} this run)`);
} else {
  console.log('  /api/status admission block unavailable (older daemon or auth/connection issue)');
}

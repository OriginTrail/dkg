#!/usr/bin/env node
/**
 * Pre-flight for the publish-stress run:
 *   1. Confirm Miles is up + on the right chain.
 *   2. Print wallet balances (so the operator can spot insufficient funds early).
 *   3. Create context graph `miles-publish-stress-26may` if it doesn't exist
 *      (`POST /api/context-graph/create { id, name, register: true,
 *       accessPolicy: 0, publishPolicy: 1 }` — public + open).
 *   4. Echo the resolved CG id (with namespace prefix) and on-chain id for
 *      the operator to plumb into publish-loop.mjs via CG_ID env var.
 *
 * No publishes happen here. The first publish lives in publish-loop.mjs
 * calibrate mode.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

const HOST = process.env.DKG_HOST ?? 'http://127.0.0.1:9200';
const TOKEN_FILE = process.env.DKG_TOKEN_FILE ?? `${homedir()}/.dkg/auth.token`;
const RUN_ID = process.env.STRESS_RUN_ID ?? '26may';
const CG_SHORT_ID = `miles-publish-stress-${RUN_ID}`;
const CG_NAME = `Miles publish stress (${RUN_ID})`;
const CG_DESCRIPTION =
  'Auto-created by scripts/testnet-publish-stress/preflight.mjs. ' +
  'Hosts a stream of Wikidata-music KCs published from Miles\' edge node ' +
  'against Base Sepolia (84532) to stress-test V10 publishing + give the ' +
  'on-chain RandomSampling prover something to sample.';
const TESTNET_CONFIG_URL = new URL('../../network/testnet.json', import.meta.url);
const TESTNET_NETWORK_ID = JSON.parse(
  await readFile(TESTNET_CONFIG_URL, 'utf8'),
).networkId;

if (typeof TESTNET_NETWORK_ID !== 'string' || TESTNET_NETWORK_ID.length === 0) {
  throw new Error(`Missing networkId in ${TESTNET_CONFIG_URL.pathname}`);
}

const TOKEN = (await readFile(TOKEN_FILE, 'utf8'))
  .split('\n')
  .find((l) => l.trim() && !l.startsWith('#'))
  .trim();

async function apiCall(method, path, body) {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text.length > 0 ? JSON.parse(text) : {}; }
  catch { json = { _raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

function bar(s) { console.error(`\n=== ${s} ===`); }

bar('1. Daemon status');
{
  const r = await apiCall('GET', '/api/status');
  if (!r.ok) {
    console.error(`status failed: HTTP ${r.status}`);
    process.exit(1);
  }
  const s = r.json;
  console.error(`name=${s.name} version=${s.version} role=${s.nodeRole} network=${s.networkName} identity=${s.identityId} (has=${s.hasIdentity}) peers=${s.connectedPeers}`);
  if (s.networkId !== TESTNET_NETWORK_ID) {
    console.error(`WARN: networkId=${s.networkId} expected ${TESTNET_NETWORK_ID} (DKG V10 Testnet). Aborting.`);
    process.exit(2);
  }
}

bar('2. Wallets');
{
  const r = await apiCall('GET', '/api/wallets/balances');
  if (!r.ok) {
    console.error(`wallets failed: HTTP ${r.status}`);
    process.exit(1);
  }
  for (const w of r.json.balances) {
    console.error(`  ${w.address}  ETH=${w.eth}  ${w.symbol}=${w.trac}`);
  }
  const tracTotal = r.json.balances.reduce((s, w) => s + parseFloat(w.trac), 0);
  const ethTotal = r.json.balances.reduce((s, w) => s + parseFloat(w.eth), 0);
  console.error(`  TOTAL  ETH=${ethTotal.toFixed(6)}  ${r.json.symbol}=${tracTotal.toFixed(4)}`);
  console.error(`  RPC: ${r.json.rpcUrl}  chain=${r.json.chainId}`);
  if (tracTotal < 50) {
    console.error('ERROR: total TRAC < 50; cannot proceed. Top up the operational wallets.');
    process.exit(2);
  }
}

bar('3. List existing context graphs');
let alreadyExists = false;
let resolvedCgId = null;
let onChainId = null;
{
  // Codex review on PR #722: the daemon-side route is `/api/context-graph/list`;
  // GET `/api/context-graph` would not list existing CGs, which made this
  // helper drop through to create() and exit on a duplicate-id 409 instead
  // of being idempotent as documented.
  const r = await apiCall('GET', '/api/context-graph/list');
  if (r.ok && Array.isArray(r.json.contextGraphs)) {
    const match = r.json.contextGraphs.find(
      (cg) => cg.id === CG_SHORT_ID || cg.id?.endsWith(`/${CG_SHORT_ID}`),
    );
    if (match) {
      alreadyExists = true;
      resolvedCgId = match.id;
      onChainId = match.onChainId;
      console.error(`  Already present: id=${resolvedCgId} onChainId=${onChainId ?? '(local-only)'}`);
    } else {
      console.error(`  ${r.json.contextGraphs.length} other CG(s) present; '${CG_SHORT_ID}' not yet created.`);
    }
  } else {
    console.error(`  (no /api/context-graph/list response — will attempt create anyway)`);
  }
}

if (!alreadyExists) {
  bar('4. Create context graph + register on-chain');
  const r = await apiCall('POST', '/api/context-graph/create', {
    id: CG_SHORT_ID,
    name: CG_NAME,
    description: CG_DESCRIPTION,
    accessPolicy: 0,    // public
    publishPolicy: 1,   // open
    register: true,
  });
  if (!r.ok) {
    console.error(`create failed: HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 500)}`);
    process.exit(1);
  }
  if (r.json.registered === false) {
    console.error(`CG created LOCALLY only — on-chain register failed: ${r.json.registerError}`);
    console.error('Cannot publish without on-chain CG. Investigate before continuing.');
    process.exit(2);
  }
  resolvedCgId = r.json.created;
  onChainId = r.json.onChainId;
  console.error(`  Created and registered: id=${resolvedCgId} onChainId=${onChainId} uri=${r.json.uri}`);
}

bar('5. Resolved CG ID for publish-loop');
console.error(`  CG short id : ${CG_SHORT_ID}`);
console.error(`  CG full id  : ${resolvedCgId}`);
console.error(`  On-chain id : ${onChainId}`);
console.error('');
console.error('Plumb into publish-loop.mjs via:');
console.error(`  export CG_ID=${resolvedCgId}`);
console.error('');
console.error('Next step:');
console.error(`  CG_ID=${resolvedCgId} PHASE=calibrate node scripts/testnet-publish-stress/publish-loop.mjs`);

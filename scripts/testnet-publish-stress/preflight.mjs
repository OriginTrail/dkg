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
import { runPreflight } from './preflight-runner.mjs';

const HOST = process.env.DKG_HOST ?? 'http://127.0.0.1:9200';
const TOKEN_FILE = process.env.DKG_TOKEN_FILE ?? `${homedir()}/.dkg/auth.token`;
const RUN_ID = process.env.STRESS_RUN_ID ?? '26may';
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

const exitCode = await runPreflight({
  apiCall,
  expectedNetworkId: TESTNET_NETWORK_ID,
  runId: RUN_ID,
});
process.exitCode = exitCode;

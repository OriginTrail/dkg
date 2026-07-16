#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { readDkgConfig } from './lib/config-file.mjs';
import { resolveDaemonAuth } from './lib/daemon-auth.mjs';
import { pollUntilFinalized } from './lib/poll.mjs';
import { assertKaMatches, assertListContains } from './lib/assertions.mjs';
import { ensureSubscribed } from './lib/subscribe.mjs';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(SELF_DIR, 'fixtures');

const NO_PAUSE = process.argv.includes('--no-pause');
const NODE1_HOME = process.env.DKG_HOME ?? join(homedir(), '.dkg');
const NODE2_HOME = process.env.NODE2_DKG_HOME ?? '';
const BASE_PATH = process.env.KAFKA_BASE_PATH ?? '/api/kafka/streams';
const CG_ID = process.env.CG_ID ?? 'kafka-streams-demo';
const ALLOW_FACTORY_CONTEXT_GRAPH = process.env.KAFKA_ALLOW_FACTORY_CONTEXT_GRAPH === '1';
const SYNC_TIMEOUT_MS = Number.parseInt(process.env.SYNC_TIMEOUT_MS ?? '60000', 10);
const POLL_INTERVAL_MS = 1000;
const FINALIZE_TIMEOUT_MS = 120_000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export function buildKafkaStreamUrls(baseUrl, basePath, captureId, ual) {
  const root = basePath.replace(/\/+$/, '');
  return {
    register: `${baseUrl}${root}/register`,
    captureStatus: `${baseUrl}${root}/register/${encodeURIComponent(captureId)}`,
    kaByUal: `${baseUrl}${root}/${encodeURIComponent(ual)}`,
    list: `${baseUrl}${root}`,
  };
}

export async function validateKafkaContextGraphConfig(nodes, expectedCgId, { allowFactoryContextGraph = false } = {}) {
  const mismatches = [];
  for (const node of nodes) {
    let cfg;
    try {
      ({ config: cfg } = await readDkgConfig(node.dkgHome, { tolerateMalformed: true }));
    } catch (err) {
      mismatches.push(`${node.label} config cannot be read: ${err?.message ?? err}`);
      continue;
    }
    if (!cfg || typeof cfg !== 'object') {
      mismatches.push(
        `${node.label} config missing (checked ${join(node.dkgHome, 'config.json')} + ` +
          `${join(node.dkgHome, 'config.yaml')})`,
      );
      continue;
    }

    const actual = cfg?.kafka?.contextGraphId;
    if ((actual === undefined && !allowFactoryContextGraph) || (actual !== undefined && actual !== expectedCgId)) {
      mismatches.push(
        `${node.label} kafka.contextGraphId=${actual === undefined ? '(missing)' : JSON.stringify(actual)} ` +
          `does not match demo context graph ${JSON.stringify(expectedCgId)}`,
      );
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      'Kafka plugin context graph config mismatch:\n' +
        mismatches.map((line) => `- ${line}`).join('\n'),
    );
  }
}

export async function resolveDemoDaemons(node1Home, node2Home) {
  const node1 = await resolveDaemonAuth(node1Home, { useEnvPort: true });
  const node2 = await resolveDaemonAuth(node2Home, { useEnvPort: false });
  return { node1, node2 };
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

async function pause(label = 'Press Enter to continue…') {
  if (NO_PAUSE) return;
  process.stdout.write(`${label} `);
  await new Promise((r) => process.stdin.once('data', () => r()));
}

function authHeaders(auth, contentType) {
  const h = {};
  if (auth.token) h.Authorization = `Bearer ${auth.token}`;
  if (contentType) h['Content-Type'] = contentType;
  return h;
}

function isTransientHttpStatus(status) {
  return TRANSIENT_HTTP_STATUSES.has(status);
}

function httpStatusError(label, url, response) {
  return new Error(
    `${label}: unexpected status=${response.status} url=${url} body=${response.body.slice(0, 300)}`,
  );
}

async function httpJson(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`fetch ${init?.method ?? 'GET'} ${url} failed: ${err?.message ?? err}`);
  }
  const text = await res.text();
  let parsed;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  }
  return { status: res.status, body: text, parsed };
}

export async function ensureContextGraph(auth, cgId, options = {}) {
  const { httpJson: requestJson = httpJson } = options;
  const res = await requestJson(`${auth.baseUrl}/api/context-graph/create`, {
    method: 'POST',
    headers: authHeaders(auth, 'application/json'),
    body: JSON.stringify({ id: cgId, name: cgId, register: true }),
  });
  if (![200, 201, 409].includes(res.status)) {
    throw new Error(
      `context-graph create on node1 failed: status=${res.status} body=${res.body.slice(0, 300)}`,
    );
  }
  if (res.status === 409 || res.parsed?.registered === false) {
    const register = await requestJson(`${auth.baseUrl}/api/context-graph/register`, {
      method: 'POST',
      headers: authHeaders(auth, 'application/json'),
      body: JSON.stringify({ id: cgId }),
    });
    if (![200, 409].includes(register.status)) {
      throw new Error(
        `context-graph register on node1 failed after duplicate create: ` +
          `status=${register.status} body=${register.body.slice(0, 300)}`,
      );
    }
  }
}

async function postRegister(auth, body) {
  const urls = buildKafkaStreamUrls(auth.baseUrl, BASE_PATH);
  const res = await httpJson(urls.register, {
    method: 'POST',
    headers: authHeaders(auth, 'application/json'),
    body: JSON.stringify(body),
  });
  if (res.status !== 202) {
    throw new Error(
      `POST ${BASE_PATH}/register expected 202; got ${res.status} body=${res.body.slice(0, 300)}`,
    );
  }
  if (!res.parsed?.captureID) {
    throw new Error(`POST register response missing captureID: ${res.body.slice(0, 300)}`);
  }
  return res.parsed.captureID;
}

export async function pollFinalized(auth, captureId, options = {}) {
  const {
    basePath = BASE_PATH,
    httpJson: requestJson = httpJson,
    intervalMs = POLL_INTERVAL_MS,
    timeoutMs = FINALIZE_TIMEOUT_MS,
  } = options;
  const urls = buildKafkaStreamUrls(auth.baseUrl, basePath, captureId);
  const fetcher = async () => {
    const r = await requestJson(
      urls.captureStatus,
      { headers: authHeaders(auth) },
    );
    if (r.status !== 200) {
      if (isTransientHttpStatus(r.status)) return { state: 'pending' };
      throw httpStatusError('capture status', urls.captureStatus, r);
    }
    return r.parsed ?? { state: 'pending' };
  };
  return pollUntilFinalized(fetcher, {
    intervalMs,
    timeoutMs,
  });
}

function normalizePollOptions(optionsOrDeadline) {
  if (typeof optionsOrDeadline === 'number') return { deadlineMs: optionsOrDeadline };
  const options = optionsOrDeadline ?? {};
  const syncTimeoutMs = options.syncTimeoutMs ?? SYNC_TIMEOUT_MS;
  return {
    ...options,
    deadlineMs: options.deadlineMs ?? Date.now() + syncTimeoutMs,
  };
}

export async function fetchKaOnNode2(auth, ual, optionsOrDeadline) {
  const {
    basePath = BASE_PATH,
    deadlineMs,
    httpJson: requestJson = httpJson,
    intervalMs = POLL_INTERVAL_MS,
    sleep: wait = sleep,
    syncTimeoutMs = SYNC_TIMEOUT_MS,
  } = normalizePollOptions(optionsOrDeadline);
  const url = buildKafkaStreamUrls(auth.baseUrl, basePath, undefined, ual).kaByUal;
  while (Date.now() < deadlineMs) {
    const r = await requestJson(url, { headers: authHeaders(auth) });
    if (r.status === 200 && r.parsed) return r.parsed;
    if (r.status !== 404 && !isTransientHttpStatus(r.status)) {
      throw httpStatusError('GET node2 KA', url, r);
    }
    await wait(intervalMs);
  }
  throw new Error(`UAL ${ual} never reached node2 within ${syncTimeoutMs}ms`);
}

export async function fetchListOnNode2(auth, ual, optionsOrDeadline) {
  const {
    basePath = BASE_PATH,
    deadlineMs,
    httpJson: requestJson = httpJson,
    intervalMs = POLL_INTERVAL_MS,
    sleep: wait = sleep,
    syncTimeoutMs = SYNC_TIMEOUT_MS,
  } = normalizePollOptions(optionsOrDeadline);
  const url = buildKafkaStreamUrls(auth.baseUrl, basePath).list;
  let last;
  while (Date.now() < deadlineMs) {
    const r = await requestJson(url, { headers: authHeaders(auth) });
    if (r.status === 200 && r.parsed?.items?.some?.((it) => it && it['@id'] === ual)) {
      return r.parsed;
    }
    if (r.status !== 200 && !isTransientHttpStatus(r.status)) {
      throw httpStatusError('node2 list', url, r);
    }
    last = r;
    await wait(intervalMs);
  }
  throw new Error(
    `UAL ${ual} never appeared in node2 list within ${syncTimeoutMs}ms ` +
      `(last status=${last?.status}, items=${last?.parsed?.items?.length ?? 0})`,
  );
}

export async function verifyNode2Sync({
  node2,
  ual,
  body,
  syncTimeoutMs = SYNC_TIMEOUT_MS,
  basePath = BASE_PATH,
  now = Date.now,
  fetchKa = fetchKaOnNode2,
  fetchList = fetchListOnNode2,
  assertKa = assertKaMatches,
  assertList = assertListContains,
  onKaVerified,
  onBeforeList,
  onListVerified,
}) {
  const ka = await fetchKa(node2, ual, {
    basePath,
    deadlineMs: now() + syncTimeoutMs,
    syncTimeoutMs,
  });
  assertKa(ka, { ual, body });
  onKaVerified?.(ka);

  onBeforeList?.();
  const list = await fetchList(node2, ual, {
    basePath,
    deadlineMs: now() + syncTimeoutMs,
    syncTimeoutMs,
  });
  assertList(list, ual);
  onListVerified?.(list);
  return { ka, list };
}

async function main() {
  log('=== kafka-streams two-node demo ===');
  log(`node1 DKG_HOME       : ${NODE1_HOME}`);
  log(`node2 NODE2_DKG_HOME : ${NODE2_HOME || '(unset — verification step will fail)'}`);
  log(`context graph        : ${CG_ID}`);
  log(`plugin base path     : ${BASE_PATH}`);
  if (!NODE2_HOME) {
    throw new Error(
      'NODE2_DKG_HOME is required for the cross-node verification step. ' +
        'See demo/kafka-streams/README.md for the runbook.',
    );
  }

  log('\n[1/6] Resolving daemon auth on both nodes…');
  const { node1, node2 } = await resolveDemoDaemons(NODE1_HOME, NODE2_HOME);
  log(`     node1 → ${node1.baseUrl}`);
  log(`     node2 → ${node2.baseUrl}`);
  log('     validating kafka.contextGraphId in both node configs…');
  await validateKafkaContextGraphConfig([
    { label: 'node1', dkgHome: NODE1_HOME },
    { label: 'node2', dkgHome: NODE2_HOME },
  ], CG_ID, { allowFactoryContextGraph: ALLOW_FACTORY_CONTEXT_GRAPH });
  log('     kafka.contextGraphId matches on both nodes.');
  await pause();

  log(`\n[2/6] Ensuring context graph "${CG_ID}" is created + on-chain registered on node1…`);
  await ensureContextGraph(node1, CG_ID);
  log('     context graph ready (idempotent).');
  await pause();

  log(`\n[3/6] Subscribing node2 to "${CG_ID}" (idempotent)…`);
  const sub = await ensureSubscribed(httpJson, node2.baseUrl, CG_ID, authHeaders(node2));
  log(`     node2 subscribed=${sub.subscribed ?? CG_ID} catchup=${sub.catchup?.status ?? 'n/a'}`);
  await pause();

  const body = JSON.parse(await readFile(join(FIXTURES, 'stream-body.json'), 'utf-8'));
  log(`\n[4/6] POST ${BASE_PATH}/register on node1 with body=${JSON.stringify(body)}`);
  const captureID = await postRegister(node1, body);
  log(`     captureID=${captureID}`);

  log('     Polling until finalized…');
  const final = await pollFinalized(node1, captureID);
  if (!final.ual) throw new Error(`finalized with empty UAL: ${JSON.stringify(final)}`);
  log(`     state=${final.state} ual=${final.ual}`);
  await pause();

  log('\n[5/6] Waiting for node2 to see the UAL (cross-node gossip)…');
  await verifyNode2Sync({
    node2,
    ual: final.ual,
    body,
    syncTimeoutMs: SYNC_TIMEOUT_MS,
    onKaVerified: () => {
      log('     node2 GET by-UAL matches the published shape.');
    },
    onBeforeList: () => {
      log('\n[6/6] Verifying UAL appears in node2 list endpoint (public-partition regression)…');
    },
    onListVerified: (list) => {
      log(`     node2 list shows ${list.items.length} item(s); target UAL present.`);
    },
  });

  log('\nOK — two-node KafkaStream registration + sync verified.');
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`\nDEMO FAILED: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}

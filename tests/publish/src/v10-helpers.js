import { randomUUID } from 'crypto';
import { fetch as undiciFetch, Agent } from 'undici';

// Node's built-in fetch aborts if response HEADERS take >5 min — but the
// 10.0.3 one-call publish route only answers AFTER the node finishes its ACK
// collection (up to ~8 min when ACKs are failing). That surfaced as
// "UND_ERR_HEADERS_TIMEOUT" and hid the node's real storage_ack error.
// This fetch waits long enough for the node's own verdict to arrive.
const HTTP_TIMEOUT_MS = Number(process.env.V10_HTTP_TIMEOUT_MS || 12 * 60 * 1000);
const longAgent = new Agent({ headersTimeout: HTTP_TIMEOUT_MS, bodyTimeout: HTTP_TIMEOUT_MS });
export const longFetch = (url, opts = {}) => undiciFetch(url, { ...opts, dispatcher: longAgent });
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Configuration (env-driven, same knobs as the V9 / V8 tests)
// ---------------------------------------------------------------------------

export const DKG_API_URL = process.env.DKG_API_URL || 'http://127.0.0.1:9200';
// V10 publishes into a CONTEXT GRAPH (the v9 analogue was a paranet).
export const DKG_CONTEXT_GRAPH_ID = process.env.DKG_CONTEXT_GRAPH_ID || 'test-publish-cg';
export const BLOCKCHAIN_NAME = process.env.BLOCKCHAIN_NAME || 'v10:base:84532';
export const DKG_AUTH_TOKEN = process.env.DKG_AUTH_TOKEN || loadAuthToken();

// V10 publish controls
export const PUBLISH_EPOCHS = Number(process.env.PUBLISH_EPOCHS || 2);
// CG creation policy (0 = public access, publishPolicy 1 = open publishing,
// register on-chain so mints confirm). Override per environment.
export const CG_ACCESS_POLICY = Number(process.env.V10_CG_ACCESS_POLICY || 0);
export const CG_PUBLISH_POLICY = Number(process.env.V10_CG_PUBLISH_POLICY || 1);
export const CG_REGISTER = String(process.env.V10_CG_REGISTER || 'true').toLowerCase() === 'true';
// The first publish right after registering a CG can transiently fail with the
// "access-policy is unknown" (LU-5) read-lag until the slot is proven live —
// retry it a few times rather than counting it as a real failure.
const LU5_RETRIES = Number(process.env.V10_LU5_RETRIES || 6);
const LU5_DELAY_MS = Number(process.env.V10_LU5_DELAY_MS || 12000);

function loadAuthToken() {
  // Prefer an explicit DKG_HOME (the v10 node home, e.g. a per-node dir), else
  // fall back to ~/.dkg — and skip the file's comment header lines.
  const home = process.env.DKG_HOME || join(homedir(), '.dkg');
  try {
    const raw = readFileSync(join(home, 'auth.token'), 'utf-8');
    const token = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('#'));
    return token || '';
  } catch {
    return '';
  }
}

export const TEST_ENTITY_COUNT = Number(process.env.TEST_ENTITY_COUNT || 500);
export const TEST_CONTENT_SIZE_KB = Number(process.env.TEST_CONTENT_SIZE_KB || 1);
export const TEST_KA_BATCHES = Number(process.env.TEST_KA_BATCHES || 10);
export const TEST_PARALLEL_KA_BATCH_SIZE = Number(process.env.TEST_PARALLEL_KA_BATCH_SIZE || 1);
export const TEST_BATCH_DELAY_MS = Number(process.env.TEST_BATCH_DELAY_MS || 0);

// ---------------------------------------------------------------------------
// Utility helpers (mirrors V9 / V8)
// ---------------------------------------------------------------------------

const WORDS = ['Galaxy', 'Nebula', 'Orbit', 'Quantum', 'Pixel', 'Velocity', 'Echo', 'Nova'];

function randomWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function randomDescription() {
  const templates = [
    'This asset explores the mysteries of {}.',
    'An in-depth look into {} technologies.',
    'Unlocking the power of {} in modern systems.',
    'How {} shapes our digital future.',
    'A fresh perspective on {} innovation.',
  ];
  const word = randomWord();
  return templates[Math.floor(Math.random() * templates.length)].replace('{}', word);
}

function createLargeText(sizeBytes) {
  const resolved = Math.max(0, Math.floor(sizeBytes));
  if (resolved === 0) return '';
  const chunk = 'OTDKG_LOAD_PAYLOAD_';
  return chunk.repeat(Math.ceil(resolved / chunk.length)).slice(0, resolved);
}

export function safeRate(success, fail) {
  const total = success + fail;
  return total === 0 ? '0.00' : ((success / total) * 100).toFixed(2);
}

export function formatDuration(ms) {
  if (!ms || isNaN(ms)) return '0.00 ms';
  // Sub-second durations (e.g. local SPARQL queries are a few ms) would round
  // to "0.00 seconds" — show them in ms so no number is lost.
  if (ms < 1000) return `${ms.toFixed(2)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)} seconds`;
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${mins} min ${secs} sec`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// RDF quad content generation (V10 publish takes {subject,predicate,object,graph};
// literals are wrapped in "...", IRIs are bare, graph is empty)
// ---------------------------------------------------------------------------

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'http://schema.org/';

export function buildQuads(nodeName, kaNumber) {
  const nodeKey = nodeName.replace(/\s+/g, '').toLowerCase();
  const rootId = `urn:ka:${nodeKey}-${randomUUID()}`;

  const quads = [];
  const addQuad = (s, p, o) => quads.push({ subject: s, predicate: p, object: o, graph: '' });
  const literal = (val) => `"${String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  // Root dataset entity
  addQuad(rootId, RDF_TYPE, `${SCHEMA}Dataset`);
  addQuad(rootId, `${SCHEMA}name`, literal(`DKG ${randomWord()} ${Date.now()}`));
  addQuad(rootId, `${SCHEMA}description`, literal(randomDescription()));
  addQuad(rootId, `${SCHEMA}dateCreated`, literal(new Date().toISOString()));
  addQuad(rootId, `urn:dkg:entityCount`, literal(TEST_ENTITY_COUNT));
  addQuad(rootId, `urn:dkg:kaNumber`, literal(kaNumber));

  // Child entities
  for (let i = 1; i <= TEST_ENTITY_COUNT; i++) {
    const entityId = `urn:entity:${nodeKey}:${kaNumber}:${i}:${randomUUID()}`;
    addQuad(entityId, RDF_TYPE, `${SCHEMA}Thing`);
    addQuad(entityId, `${SCHEMA}name`, literal(`${randomWord()}-${i}`));
    addQuad(entityId, `${SCHEMA}description`, literal(randomDescription()));
    addQuad(entityId, `${SCHEMA}isPartOf`, rootId);
  }

  // Pad to target size
  const currentBytes = Buffer.byteLength(JSON.stringify(quads), 'utf8');
  const targetBytes = Math.max(0, Math.floor(TEST_CONTENT_SIZE_KB * 1024));
  const fillerBytes = Math.max(0, targetBytes - currentBytes);
  if (fillerBytes > 0) {
    addQuad(rootId, `urn:dkg:filler`, literal(createLargeText(fillerBytes)));
  }

  return { quads, rootEntity: rootId };
}

// ---------------------------------------------------------------------------
// HTTP helpers — talk to the V10 daemon API
// ---------------------------------------------------------------------------

async function httpRequest(method, path, body, { acceptStatuses } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (DKG_AUTH_TOKEN) headers['Authorization'] = `Bearer ${DKG_AUTH_TOKEN}`;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await longFetch(`${DKG_API_URL}${path}`, opts);
  } catch (e) {
    // "TypeError: fetch failed" hides the real transport error in e.cause —
    // surface it in the message so every log/summary shows the actual reason.
    const err = new Error(`${method} ${path} on ${DKG_API_URL} got no HTTP response: ${summarizeCause(e) || e.message}`);
    err.cause = e.cause ?? e;
    err.network = true;
    throw err;
  }
  const data = await res.json().catch(() => ({ error: res.statusText }));
  const ok = acceptStatuses ? acceptStatuses.includes(res.status) : res.ok;
  if (!ok) {
    const err = new Error(data.error || data.contextGraphError || `HTTP ${res.status}`);
    err.statusCode = res.status;
    err.body = data;
    throw err;
  }
  return { status: res.status, data };
}

export async function httpStatus() {
  return (await httpRequest('GET', '/api/status')).data;
}

/** Create + (optionally) on-chain-register the context graph to publish into. */
export async function httpCreateContextGraph(id, name, description) {
  const { data } = await httpRequest('POST', '/api/context-graph/create', {
    id, name, description,
    accessPolicy: CG_ACCESS_POLICY,
    publishPolicy: CG_PUBLISH_POLICY,
    register: CG_REGISTER,
  });
  if (CG_REGISTER && (data.registerError || data.registered !== true || !data.onChainId)) {
    const reason = data.registerError || `registered=${data.registered}, onChainId=${data.onChainId ?? 'none'}`;
    throw new Error(`Context graph on-chain registration failed: ${reason}`);
  }
  return data;
}

/**
 * Publish quads to verifiable memory. Accepts HTTP 200 (fully bound) and 207
 * (minted on-chain but context-graph binding failed) as success; retries the
 * transient LU-5 "access-policy is unknown" read-lag.
 */
export async function httpPublish(contextGraphId, quads) {
  let lastErr;
  for (let attempt = 0; attempt <= LU5_RETRIES; attempt++) {
    try {
      // v10.0.3 removed POST /api/knowledge-assets/publish (PR #1275): the
      // named-KA create route now runs the full lifecycle in one call
      // (create + wm/write + wm/finalize + swm/share + vm/publish) and returns
      // kaId/ual/txHash/authorAddress with status "vm-confirmed".
      const { status, data } = await httpRequest(
        'POST', '/api/knowledge-assets',
        {
          contextGraphId,
          name: `jenkins-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          quads,
          alsoShareSwm: true,
          alsoPublishVm: { publishEpochs: PUBLISH_EPOCHS },
        },
        { acceptStatuses: [200, 201, 207] },
      );
      return {
        ...data,
        status: data.status === 'vm-confirmed' ? 'confirmed' : data.status,
        publisherAddress: data.publisherAddress || data.authorAddress,
        httpStatus: status,
      };
    } catch (err) {
      lastErr = err;
      if (String(err.message || '').includes('access-policy is unknown') && attempt < LU5_RETRIES) {
        await sleep(LU5_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function httpQuery(sparql, contextGraphId, view = 'verifiable-memory') {
  return (await httpRequest('POST', '/api/query', { sparql, contextGraphId, view })).data;
}

// ---------------------------------------------------------------------------
// Deep error diagnostics. Node's fetch reports every transport failure as
// "TypeError: fetch failed" and hides the real reason in `error.cause`
// (ECONNREFUSED / ETIMEDOUT / ECONNRESET / undici UND_ERR_*). These helpers
// unwrap the cause chain into a specific message, classify it in operator
// terms, re-probe the node, and pull the node's OWN server logs from Loki so
// the Jenkins console shows what the server was doing at failure time.
// ---------------------------------------------------------------------------

const LOKI_URL = (process.env.V10_LOKI_URL || 'http://100.81.85.62:3100').replace(/\/$/, '');
const GRAFANA_URL = (process.env.V10_GRAFANA_URL || 'http://100.81.85.62:3000').replace(/\/$/, '');
const SERVER_LOGS = String(process.env.V10_SERVER_LOGS || 'true').toLowerCase() !== 'false';

// Walk error.cause (and AggregateError.errors) into flat descriptors.
export function unwrapCauseChain(error) {
  const out = [];
  const seen = new Set();
  const visit = (e, depth) => {
    if (!e || depth > 6 || seen.has(e)) return;
    seen.add(e);
    out.push({
      name: e.name || 'Error',
      code: e.code || null,
      syscall: e.syscall || null,
      address: e.address || null,
      port: e.port || null,
      message: e.message || String(e),
    });
    if (Array.isArray(e.errors)) e.errors.forEach((sub) => visit(sub, depth + 1)); // AggregateError
    if (e.cause) visit(e.cause, depth + 1);
  };
  if (error?.cause) visit(error.cause, 0);
  else if (error && (error.code || Array.isArray(error.errors))) visit(error, 0);
  return out;
}

// code → what it actually means for THIS setup, in operator terms.
const NETWORK_DIAGNOSES = {
  ECONNREFUSED: (t) => `connection REFUSED at ${t} — the machine is reachable but nothing is listening on that port: the node daemon is DOWN (or listening on a different port).`,
  ETIMEDOUT: (t) => `connect TIMEOUT to ${t} — no answer from the host at all: the node machine is offline/unreachable, or the VPN (Tailscale) path between the Jenkins agent and the node is down.`,
  UND_ERR_CONNECT_TIMEOUT: (t) => `connect TIMEOUT to ${t} — no answer from the host at all: the node machine is offline/unreachable, or the VPN (Tailscale) path between the Jenkins agent and the node is down.`,
  EHOSTUNREACH: (t) => `host UNREACHABLE (${t}) — no network route: VPN (Tailscale) down on the Jenkins agent, or the node dropped off the tailnet.`,
  ENETUNREACH: (t) => `network UNREACHABLE (${t}) — the Jenkins agent has no route (its VPN/interface is down).`,
  ECONNRESET: (t) => `connection RESET by ${t} mid-request — the daemon accepted the request and then the socket died: daemon crash/restart or OOM-kill while handling it. The server logs right before this moment are the evidence.`,
  UND_ERR_SOCKET: (t) => `socket closed by ${t} mid-request — the daemon accepted the request and then the connection died: daemon crash/restart while handling it. Check the server logs right before this moment.`,
  EPIPE: (t) => `broken pipe to ${t} — connection died while sending the request body.`,
  ENOTFOUND: (t) => `DNS lookup failed for ${t} — hostname does not resolve on the Jenkins agent.`,
  EAI_AGAIN: (t) => `transient DNS failure for ${t} on the Jenkins agent.`,
  UND_ERR_HEADERS_TIMEOUT: (t) => `the node at ${t} ACCEPTED the connection but never sent response headers — daemon wedged/overloaded (request may appear in server logs without a response).`,
  UND_ERR_BODY_TIMEOUT: (t) => `the node at ${t} started responding but stalled mid-body — daemon wedged/overloaded.`,
  ABORT_ERR: (t) => `request to ${t} aborted by the test's own timeout — the node did not answer in time (wedged or very slow). Server logs may show the request arriving.`,
};

// Human summary of the deepest useful cause, e.g. "connect ETIMEDOUT 100.100.87.86:9200".
export function summarizeCause(error) {
  const chain = unwrapCauseChain(error);
  if (!chain.length) return null;
  const best = chain.find((c) => c.code) || chain[chain.length - 1];
  const target = best.address ? `${best.address}${best.port ? `:${best.port}` : ''}` : '';
  return [best.syscall, best.code, target].filter(Boolean).join(' ') || best.message;
}

export function describeError(error, targetUrl = '') {
  const chain = unwrapCauseChain(error);
  const causeLines = chain.map((c) => {
    const parts = [`${c.name}${c.code ? ` ${c.code}` : ''}`];
    if (c.syscall) parts.push(`syscall=${c.syscall}`);
    if (c.address) parts.push(`target=${c.address}${c.port ? `:${c.port}` : ''}`);
    if (!c.code && c.message) parts.push(c.message);
    return parts.join(' | ');
  });
  const codes = chain.map((c) => c.code).filter(Boolean);
  const code = codes[0]
    || (error?.name === 'AbortError' ? 'ABORT_ERR' : null)
    || (/^timeout after/i.test(error?.message || '') ? 'ABORT_ERR' : null);
  const best = chain.find((c) => c.code) || {};
  const target = best.address ? `${best.address}${best.port ? `:${best.port}` : ''}` : (targetUrl || 'the node');
  const diagnose = code && NETWORK_DIAGNOSES[code];
  const isNetwork = Boolean(error?.network || (!error?.statusCode && (chain.length || /fetch failed/i.test(error?.message || ''))));
  return { causeLines, code, diagnosis: diagnose ? diagnose(target) : null, isNetwork };
}

// Re-check the node's public /api/status RIGHT NOW — distinguishes "node is
// down" from "one-off blip during that request".
export async function probeNode(baseUrl) {
  if (!baseUrl) return null;
  try {
    const res = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { alive: false, detail: `HTTP ${res.status} from /api/status` };
    const d = await res.json().catch(() => ({}));
    return { alive: true, detail: `/api/status OK (version ${d.version || '?'}, peers ${d.connectedPeers ?? '?'}) — node is UP now, so the failure was transient` };
  } catch (e) {
    return { alive: false, detail: `/api/status also failing (${summarizeCause(e) || e.message}) — node API is DOWN right now, not a one-off blip` };
  }
}

// Pull the node's own recent WARN/ERROR server logs around the failure from
// Loki (fail-soft: diagnostics must never break the test itself).
// If Loki is unreachable from this runner (e.g. the Jenkins agent has no
// network route to the telemetry server), remember that after the first
// attempt and skip straight to the Grafana link — don't pay the connect
// timeout again on every subsequent error.
let lokiUnreachable = false;
export async function fetchServerLogs(nodeName, whenMs) {
  if (!SERVER_LOGS) return null;
  if (lokiUnreachable) {
    return { lines: [], note: `Loki not reachable from this runner — open the Grafana link below for the server logs.` };
  }
  const q = async (logql, limit) => {
    const params = new URLSearchParams({
      query: logql,
      start: String((whenMs - 10 * 60e3) * 1e6),
      end: String((whenMs + 60e3) * 1e6),
      limit: String(limit),
      direction: 'backward',
    });
    const res = await fetch(`${LOKI_URL}/loki/api/v1/query_range?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Loki HTTP ${res.status}`);
    const data = await res.json();
    const entries = (data?.data?.result || []).flatMap((s) =>
      (s.values || []).map(([ns, line]) => ({
        ts: new Date(Number(ns) / 1e6).toISOString(),
        level: s.stream?.severity_text || s.stream?.detected_level || '',
        line,
      })));
    entries.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    return entries;
  };
  try {
    const errors = await q(`{service_instance_id="${nodeName}"} | severity_text=~\`WARN|ERROR\``, 12);
    if (errors.length) return { lines: errors, note: `last ${errors.length} WARN/ERROR server log line(s) from ${nodeName} in the 10 min before the failure:` };
    const any = await q(`{service_instance_id="${nodeName}"}`, 5);
    if (any.length) {
      return { lines: any, note: `no WARN/ERROR on the ${nodeName} server in this window — its last activity (any level):` };
    }
    return { lines: [], note: `${nodeName} shipped NO server logs at all in this window — the node process/host (or its log pipeline) looks down.` };
  } catch (e) {
    // network-level failure (timeout/refused) = no route from this runner;
    // an HTTP error from Loki itself means it IS reachable, so keep trying.
    if (!/Loki HTTP \d+/.test(e.message)) lokiUnreachable = true;
    return { lines: [], note: `server-log lookup unavailable (${e.message}) — open the Grafana link below for the server logs.` };
  }
}

export function grafanaLogsLink(nodeName, whenMs) {
  return `${GRAFANA_URL}/d/dkg-node-logs?var-node=${encodeURIComponent(nodeName)}&from=${whenMs - 15 * 60e3}&to=${whenMs + 5 * 60e3}`;
}

// ---------------------------------------------------------------------------
// Error categorization (V10 patterns) + logError (mirrors V9 / V8)
// ---------------------------------------------------------------------------

export function categorizeErrorService(error) {
  const message = (error.message || '').toLowerCase();

  if (message.includes('unauthorized') || message.includes('bearer token') || message.includes('forbidden')) return 'auth';
  if (message.includes('access-policy is unknown') || message.includes('lu-5')) return 'cg-policy-readlag';
  if (message.includes('storage_ack') || message.includes('quorum') || message.includes('no_response')) return 'storage-ack-quorum';
  if (message.includes('toolowallowance') || message.includes('toolowbalance') || message.includes('execution reverted')) return 'blockchain-rpc';
  if (message.includes('context graph') || message.includes('contextgraph')) return 'context-graph';
  if (message.includes('triple') || message.includes('oxigraph') || message.includes('sparql')) return 'triple-store';
  if (message.includes('econnrefused') || message.includes('econnreset') || message.includes('etimedout')) return 'network';
  if (message.includes('timeout')) return 'test-timeout';
  if (message.includes('tentative') || message.includes('not confirmed')) return 'chain-finalization';
  if (message.includes('quad') || message.includes('publish')) return 'publish-handler';
  if (message.includes('query')) return 'query-engine';
  return 'other';
}

// Collapse per-occurrence-unique tokens to placeholders so otherwise-identical
// errors aggregate into ONE bucket ("10x") instead of N separate "1x" entries.
// Strips, in order: the verbose ethers CALL_EXCEPTION tail (action/data/
// transaction/version — boilerplate that also carries volatile calldata), UALs &
// entity URIs, UUIDs, hex (addresses/hashes), and long decimal amounts (wei bids
// like the varying TooLowBalance `need`). Designed to be future-proof: any new
// error whose only differences are ids/hashes/numbers will still aggregate.
export function normalizeErrorMessage(message) {
  return String(message)
    // drop the ethers v6 "(action=\"estimateGas\", data=..., transaction={...}, ...)" tail
    .replace(/\s*\(action=["'][\s\S]*$/i, '')
    // drop the ethers v5 "(transaction=\"0x...\", info={...})" tail — same boilerplate,
    // different shape (e.g. "insufficient funds for intrinsic transaction cost (transaction=...")
    .replace(/\s*\(transaction=["'][\s\S]*$/i, '')
    .replace(/urn:(?:ka|entity):[A-Za-z0-9_.:-]+/g, '<entity>')
    .replace(/did:dkg:[^\s"'),]+/gi, '<ual>')
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<id>')
    .replace(/0x[0-9a-fA-F]{6,}/g, '<hex>')
    // long decimal numbers (wei amounts, token bids, timestamps) — keep small
    // numbers like chain ids / KA counts intact
    .replace(/\b\d{6,}\b/g, '<n>')
    .trim();
}

// Make an error line human-readable without losing meaning:
//  - drop the ethers "(action=...)"/"(transaction=\"0x...\")" calldata tails
//  - insufficient-funds: replace the raw wei blob with readable ETH amounts
//  - QuorumUnmetError: unwrap "[QuorumUnmetError(collected=..., peers=[...])]"
//    into a compact "(peers: a→reason; b→reason)" tail
//  - collapse to one line
export function makeReadableError(raw) {
  let s = String(raw ?? '')
    .replace(/\s*\((?:action|transaction)=["'][\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // insufficient funds: "address 0x... have 2439821196809 want 130018081746000"
  // → "wallet has 0.00000244 ETH, tx needs 0.00013002 ETH"
  const funds = /insufficient funds[^.[(]*?have (\d+) want (\d+)/i.exec(s);
  if (funds) {
    const toEth = (wei) => {
      const v = Number(wei) / 1e18;
      return v >= 0.0001 ? v.toFixed(5) : v.toFixed(8).replace(/0+$/, '0');
    };
    s = s.replace(
      /insufficient funds[^.[(]*?have \d+ want \d+/i,
      `insufficient funds for intrinsic transaction cost — wallet has ${toEth(funds[1])} ETH, tx needs ${toEth(funds[2])} ETH`,
    );
  }

  // QuorumUnmetError bracket → compact per-peer tail. The sentence before it
  // already says "got X/Y valid ACKs ... quorum no longer reachable"; keep the
  // peers (that's the actionable part) but drop the wrapper + dial= noise.
  const qm = /\s*\[QuorumUnmetError\([^)]*peers=\[([^\]]*)\]\)\]/.exec(s);
  if (qm) {
    const peers = qm[1]
      .split(';')
      .map((p) => p.trim().replace(/^(\S+)\s*\((?:dial=\w+,\s*)?reason=([^)]+)\)$/, '$1→$2'))
      .filter(Boolean)
      .join('; ');
    s = s.replace(qm[0], peers ? ` (peers: ${peers})` : '');
  }
  // drop a "Declines: ..." run-on when the peers tail already carries the reasons
  if (qm) s = s.replace(/\s*Declines:[^([]*?(?=\(peers:)/, ' ');

  // Keep only the CORE error: drop per-peer decline dumps and peers tails —
  // "storage_ack_timeout: only 0/3 ACKs received within 120000ms." is the
  // signal; the 16-peer decline list is noise (console AND Grafana).
  s = s
    .replace(/\s*Declines?:[\s\S]*$/i, '')
    .replace(/\s*\(peers:[\s\S]*$/i, '')
    .replace(/\s*\[QuorumUnmetError[\s\S]*$/i, '');

  return s.trim();
}

// diag (optional): { baseUrl } — kept for call-site compatibility; the output
// is intentionally MINIMAL now: exactly two lines per failure.
//   SERVER ERROR LOG - the node's own error (lifecycle error / HTTP error body)
//   TEST ERROR LOG   - the harness-side error (what the test observed)
// When there is no distinct server-side error (pure transport failure), both
// lines carry the same message — by design, so the pair is always present.
export async function logError(error, nodeName, step, errorStats, kaNumber = null, diag = {}) { // eslint-disable-line no-unused-vars
  console.log(`\n❌ Error on ${nodeName} during ${step}${kaNumber ? ` (KA #${kaNumber})` : ''}`);

  const testError = makeReadableError(error.message.split('\n')[0]);
  // Server-side error, in preference order: explicit lifecycle error attached
  // at the throw site → HTTP error body from the node → (none) mirror the test
  // error so both lines always exist.
  const serverRaw = error.serverError
    ?? (error.body && (error.body.error || error.body.contextGraphError))
    ?? (error.statusCode ? error.message.split('\n')[0] : null);
  const serverError = makeReadableError(serverRaw ?? testError);

  console.log(`SERVER ERROR LOG - ${serverError}`);
  console.log(`TEST ERROR LOG - ${testError}`);

  if (!errorStats[nodeName]) errorStats[nodeName] = {};

  // Grafana/DB: ONE field carrying both errors. Aggregation still buckets
  // repeat failures via normalizeErrorMessage (ids/hashes/amounts collapsed).
  const compact = (s, n) => {
    const t = String(s).trim();
    if (t.length <= n) return t;
    const cut = t.slice(0, n);
    const lastSpace = cut.lastIndexOf(' ');
    return `${cut.slice(0, lastSpace > n - 40 ? lastSpace : n).trimEnd()}…`;
  };
  const service = categorizeErrorService(error);
  // Grafana/DB gets ONLY the server-side error (the Jenkins console above
  // keeps both lines). The step prefix exists purely for the DB column
  // routing in insert_errors_to_db.js, which strips it before insert.
  const serverPart = compact(normalizeErrorMessage(serverError), 300);
  const aggregatedKey = `${step} — ${serverPart}`;
  let detailedKey = aggregatedKey;
  if (kaNumber) detailedKey += ` for KA #${kaNumber}`;

  if (!errorStats[nodeName].aggregated) errorStats[nodeName].aggregated = {};
  if (!errorStats[nodeName].detailed) errorStats[nodeName].detailed = {};
  if (!errorStats[nodeName].services) errorStats[nodeName].services = {};

  errorStats[nodeName].aggregated[aggregatedKey] = (errorStats[nodeName].aggregated[aggregatedKey] || 0) + 1;
  errorStats[nodeName].detailed[detailedKey] = (errorStats[nodeName].detailed[detailedKey] || 0) + 1;
  errorStats[nodeName].services[aggregatedKey] = service;
}

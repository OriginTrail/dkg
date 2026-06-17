import { randomUUID } from 'crypto';
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
  const res = await fetch(`${DKG_API_URL}${path}`, opts);
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
      const { status, data } = await httpRequest(
        'POST', '/api/knowledge-assets/publish',
        { contextGraphId, quads, publishEpochs: PUBLISH_EPOCHS },
        { acceptStatuses: [200, 207] },
      );
      return { ...data, httpStatus: status };
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
// Error categorization (V10 patterns) + logError (mirrors V9 / V8)
// ---------------------------------------------------------------------------

export function categorizeErrorService(error) {
  const message = (error.message || '').toLowerCase();

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

export function logError(error, nodeName, step, errorStats, kaNumber = null) {
  console.log(`\n❌ Error on ${nodeName} during ${step}`);
  console.log(`Type: ${error.name}`);

  let cleanMessage = error.message;
  if (cleanMessage.includes('Transaction has been reverted') || cleanMessage.includes('VM Exception')) {
    cleanMessage = cleanMessage.split('\n')[0];
  }
  console.log(`Message: ${cleanMessage}`);

  if (!errorStats[nodeName]) errorStats[nodeName] = {};

  const cleanErrorMessage = error.message.split('\n')[0];
  const service = categorizeErrorService(error);

  const aggregatedKey = `${step} — ${error.name}: ${cleanErrorMessage}`;
  let detailedKey = `${step} — ${error.name}: ${error.message.split('\n')[0]}`;
  if (kaNumber) detailedKey += ` for KA #${kaNumber}`;

  if (!errorStats[nodeName].aggregated) errorStats[nodeName].aggregated = {};
  if (!errorStats[nodeName].detailed) errorStats[nodeName].detailed = {};
  if (!errorStats[nodeName].services) errorStats[nodeName].services = {};

  errorStats[nodeName].aggregated[aggregatedKey] = (errorStats[nodeName].aggregated[aggregatedKey] || 0) + 1;
  errorStats[nodeName].detailed[detailedKey] = (errorStats[nodeName].detailed[detailedKey] || 0) + 1;
  errorStats[nodeName].services[aggregatedKey] = service;
}

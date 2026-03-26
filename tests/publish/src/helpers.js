import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Configuration (env-driven, same knobs as V8 dkg.js tests)
// ---------------------------------------------------------------------------

export const DKG_API_URL = process.env.DKG_API_URL || 'http://127.0.0.1:9200';
export const DKG_PARANET_ID = process.env.DKG_PARANET_ID || 'test-publish-paranet';
export const BLOCKCHAIN_NAME = process.env.BLOCKCHAIN_NAME || 'v9:base:84532';
export const DKG_AUTH_TOKEN = process.env.DKG_AUTH_TOKEN || loadAuthToken();

function loadAuthToken() {
  try {
    const raw = readFileSync(join(homedir(), '.dkg', 'auth.token'), 'utf-8');
    const token = raw.split('\n').map(l => l.trim()).find(l => l.length > 0 && !l.startsWith('#'));
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
// Utility helpers (mirrors V8)
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
  if (!ms || isNaN(ms)) return '0.00 seconds';
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
// RDF quad content generation
// ---------------------------------------------------------------------------

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'http://schema.org/';

/**
 * Build an array of RDF quads suitable for POST /api/publish.
 * Mirrors V8's buildContent() but outputs {subject, predicate, object, graph} tuples
 * instead of JSON-LD.
 */
export function buildQuads(nodeName, kaNumber, paranetId = DKG_PARANET_ID) {
  const nodeKey = nodeName.replace(/\s+/g, '').toLowerCase();
  const rootId = `urn:ka:${nodeKey}-${randomUUID()}`;
  const graphUri = `did:dkg:paranet:${paranetId}`;

  const quads = [];

  const addQuad = (s, p, o) => quads.push({ subject: s, predicate: p, object: o, graph: graphUri });
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

  return { quads, rootEntity: rootId, graphUri };
}

// ---------------------------------------------------------------------------
// HTTP helpers — talk to V9 daemon API
// ---------------------------------------------------------------------------

async function httpRequest(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (DKG_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${DKG_AUTH_TOKEN}`;
  }
  const opts = { method, headers };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

export async function httpStatus(baseUrl = DKG_API_URL) {
  return httpRequest('GET', `${baseUrl}/api/status`);
}

export async function httpPublish(paranetId, quads, baseUrl = DKG_API_URL) {
  return httpRequest('POST', `${baseUrl}/api/publish`, { paranetId, quads });
}

export async function httpQuery(sparql, paranetId, baseUrl = DKG_API_URL) {
  return httpRequest('POST', `${baseUrl}/api/query`, { sparql, paranetId });
}

export async function httpCreateParanet(id, name, description, baseUrl = DKG_API_URL) {
  return httpRequest('POST', `${baseUrl}/api/paranet/create`, { id, name, description });
}

// ---------------------------------------------------------------------------
// Error categorization (adapted from V8 for V9 error patterns)
// ---------------------------------------------------------------------------

export function categorizeErrorService(error) {
  const message = (error.message || '').toLowerCase();

  if (message.includes('triple') || message.includes('oxigraph') || message.includes('sparql')) {
    return 'triple-store';
  }
  if (message.includes('econnrefused') || message.includes('econnreset') || message.includes('etimedout')) {
    return 'network';
  }
  if (message.includes('timeout')) {
    return 'test-timeout';
  }
  if (message.includes('paranet')) {
    return 'paranet';
  }
  if (message.includes('confirmed') || message.includes('tentative') || message.includes('on-chain')) {
    return 'chain-finalization';
  }
  if (message.includes('quad') || message.includes('publish')) {
    return 'publish-handler';
  }
  if (message.includes('query')) {
    return 'query-engine';
  }
  return 'other';
}

/**
 * Log and record an error — mirrors V8's logError() exactly.
 */
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

  let aggregatedKey = `${step} — ${error.name}: ${cleanErrorMessage}`;
  let detailedKey = `${step} — ${error.name}: ${error.message.split('\n')[0]}`;
  if (kaNumber) {
    detailedKey += ` for KA #${kaNumber}`;
  }

  if (!errorStats[nodeName].aggregated) errorStats[nodeName].aggregated = {};
  if (!errorStats[nodeName].detailed) errorStats[nodeName].detailed = {};
  if (!errorStats[nodeName].services) errorStats[nodeName].services = {};

  errorStats[nodeName].aggregated[aggregatedKey] = (errorStats[nodeName].aggregated[aggregatedKey] || 0) + 1;
  errorStats[nodeName].detailed[detailedKey] = (errorStats[nodeName].detailed[detailedKey] || 0) + 1;
  errorStats[nodeName].services[aggregatedKey] = service;
}

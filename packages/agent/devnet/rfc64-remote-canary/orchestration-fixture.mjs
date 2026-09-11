// SPDX-License-Identifier: Apache-2.0

import {
  CATALOG_SWM_ASK,
  CG,
  RECEIVER_SECRET,
  RECEIVER_URL,
  SOURCE_SECRET,
  baseConfig,
  jsonResponse,
  rpcEvidence,
  statusBody,
} from './test-support.mjs';

export function createCertificationRuntime({
  failOfflineShare = false,
  catalogSwmPresent = true,
  legacySyncAllowed = false,
  contextGraphIds = [CG],
  mutateJsonBody,
  rpcEvidenceConfig = baseConfig(),
} = {}) {
  const contextGraphConfig = new Map(
    rpcEvidenceConfig.contextGraphs.map((entry) => [entry.id, entry]),
  );
  const state = {
    receiverOnline: true,
    receiverMarkers: new Set(),
    sourceMarkers: new Set(),
    pendingMarkers: new Set(),
    commands: [],
    requests: [],
  };
  const fetchFn = async (input, options = {}) => {
    const url = new URL(input);
    const isReceiver = url.origin === RECEIVER_URL;
    const method = options.method ?? 'GET';
    const authorization = new Headers(options.headers).get('authorization');
    state.requests.push({ origin: url.origin, path: url.pathname, method, authorization });
    if (isReceiver && !state.receiverOnline) throw new TypeError('offline endpoint details');
    if (url.pathname === '/api/status') {
      if (!['GET', 'HEAD'].includes(method) || options.body !== undefined) {
        return jsonResponse({ error: 'invalid status request' }, 400);
      }
      return new Response(method === 'HEAD' ? null : JSON.stringify(statusBody({
        legacySyncAllowed,
        contextGraphIds,
      })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/api/knowledge-assets' && method === 'POST') {
      const body = parseFixtureBody(options.body, url.pathname, mutateJsonBody);
      if (!validMarkerShare(body, contextGraphIds)) {
        return jsonResponse({ error: 'invalid marker request' }, 400);
      }
      if (failOfflineShare && !state.receiverOnline) return jsonResponse({ error: 'sensitive' }, 500);
      const marker = body.quads[0].subject;
      state.sourceMarkers.add(marker);
      if (state.receiverOnline) state.receiverMarkers.add(marker);
      else state.pendingMarkers.add(marker);
      return jsonResponse({ swmShared: true, assertionUri: 'urn:must-not-persist' });
    }
    if (url.pathname === '/api/query' && method === 'POST') {
      const body = parseFixtureBody(options.body, url.pathname, mutateJsonBody);
      if (!validQuery(body, contextGraphConfig)) {
        return jsonResponse({ error: 'invalid query request' }, 400);
      }
      if (body.view === 'verifiable-memory') {
        return jsonResponse({ result: { type: 'boolean', value: true } });
      }
      if (body.sparql === CATALOG_SWM_ASK || body.sparql.includes('known:second-swm-subject')) {
        return jsonResponse({ result: { type: 'boolean', value: catalogSwmPresent } });
      }
      const marker = body.sparql.match(/<([^>]+)>/)?.[1];
      const present = isReceiver
        ? state.receiverMarkers.has(marker)
        : state.sourceMarkers.has(marker);
      return jsonResponse({ result: { type: 'boolean', value: present } });
    }
    if (url.pathname === '/api/rfc64/unauthorized-probe') {
      if (method !== 'GET' || options.body !== undefined || authorization !== null) {
        return jsonResponse({ code: 'WRONG_AUTH_MODE' }, 500);
      }
      return jsonResponse({ code: 'RFC64_DENIED', detail: SOURCE_SECRET }, 403);
    }
    if (url.pathname === '/api/rfc64/revoked-probe') {
      if (
        method !== 'GET'
        || options.body !== undefined
        || authorization !== `Bearer ${RECEIVER_SECRET}`
      ) {
        return jsonResponse({ code: 'WRONG_AUTH_MODE' }, 500);
      }
      return jsonResponse({ code: 'RFC64_REVOKED', detail: RECEIVER_SECRET }, 403);
    }
    return jsonResponse({ error: 'not found' }, 404);
  };
  const runCommand = async (command) => {
    state.commands.push(command.argv[1]);
    if (command.argv[1] === 'stop') state.receiverOnline = false;
    if (command.argv[1] === 'start') {
      state.receiverOnline = true;
      for (const marker of state.pendingMarkers) state.receiverMarkers.add(marker);
    }
    return { code: 0, signal: null, stdout: '' };
  };
  const readFileFn = async (path) => {
    if (path === '/run/secrets/source') return SOURCE_SECRET;
    if (path === '/run/secrets/receiver') return RECEIVER_SECRET;
    if (path === '/tmp/redacted-rpc-evidence.json') return rpcEvidence(rpcEvidenceConfig);
    throw new Error('unexpected read');
  };
  const now = () => new Date('2026-09-11T00:02:30.000Z');
  const sleep = async () => undefined;
  return { state, fetchFn, runCommand, readFileFn, now, sleep };
}

function parseFixtureBody(serialized, path, mutateJsonBody) {
  let body;
  try {
    body = JSON.parse(serialized);
  } catch {
    return null;
  }
  return mutateJsonBody?.({ path, body }) ?? body;
}

function validMarkerShare(body, contextGraphIds) {
  if (
    body === null
    || typeof body !== 'object'
    || !contextGraphIds.includes(body.contextGraphId)
    || body.alsoShareSwm !== true
    || !Array.isArray(body.quads)
    || body.quads.length !== 1
  ) return false;
  const match = /^rfc64-canary-([0-9a-f-]{36})$/u.exec(body.name);
  if (match === null) return false;
  const nonce = match[1];
  const quad = body.quads[0];
  return quad !== null
    && typeof quad === 'object'
    && quad.subject === `urn:dkg:rfc64-canary:${nonce}`
    && quad.predicate === 'https://schema.origintrail.io/rfc64/canaryValue'
    && quad.object === JSON.stringify(nonce);
}

function validQuery(body, contextGraphConfig) {
  if (
    body === null
    || typeof body !== 'object'
    || typeof body.sparql !== 'string'
    || !['shared-working-memory', 'verifiable-memory'].includes(body.view)
  ) return false;
  const configured = contextGraphConfig.get(body.contextGraphId);
  if (configured === undefined) return false;
  if (body.view === 'verifiable-memory') return body.sparql === configured.vmAskSparql;
  if (body.sparql === configured.catalogSwmAskSparql) return true;
  const marker = /^ASK \{ <(urn:dkg:rfc64-canary:([0-9a-f-]{36}))> <https:\/\/schema\.origintrail\.io\/rfc64\/canaryValue> "([0-9a-f-]{36})" \. \}$/u.exec(body.sparql);
  return marker !== null && marker[2] === marker[3];
}

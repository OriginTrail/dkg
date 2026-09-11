// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Parser as SparqlParser } from '@traqula/parser-sparql-1-1';

import {
  CONFIG_SCHEMA,
  assertJsonData,
  invalid,
  opaqueRef,
} from './common.mjs';
import { validateCommandV1 } from './command-policy.mjs';

const DEFAULT_TIMING = Object.freeze({
  requestTimeoutMs: 10_000,
  pollIntervalMs: 2_000,
  propagationTimeoutMs: 120_000,
  catchupTimeoutMs: 240_000,
  parityTimeoutMs: 120_000,
});
const DEFAULT_LIFECYCLE = Object.freeze({
  commandTimeoutMs: 60_000,
  stopTimeoutMs: 60_000,
  readyTimeoutMs: 180_000,
});
const DEFAULT_RPC_USAGE = Object.freeze({
  minimumSamples: 1,
  commandTimeoutMs: 60_000,
});
const configSchema = JSON.parse(readFileSync(
  new URL('./config.schema.json', import.meta.url),
  'utf8',
));
const schemaValidator = new Ajv2020({ allErrors: false, strict: true });
addFormats(schemaValidator);
const matchesRemoteCanaryConfigV1 = schemaValidator.compile(configSchema);
const sparqlParser = new SparqlParser();

/**
 * The JSON Schema is the canonical shape contract. Handwritten checks below
 * are limited to cross-references, normalization, and safety semantics.
 */
export function validateRemoteCanaryConfigV1(input) {
  if (!matchesRemoteCanaryConfigV1(input)) invalid('config-shape');

  const nodeIds = new Set();
  const nodes = input.nodes.map((node) => {
    if (nodeIds.has(node.id)) invalid('duplicate-node-id');
    nodeIds.add(node.id);
    const baseUrl = validateBaseUrl(node.baseUrl, node.allowTailscaleHttp === true);
    const auth = node.auth.kind === 'none'
      ? Object.freeze({ kind: 'none' })
      : Object.freeze({ kind: 'bearer-file', secretFile: validateSecretFile(node.auth.secretFile) });
    return Object.freeze({ ...node, baseUrl, auth, nodeRef: opaqueRef('node', node.id) });
  });
  if (!nodes.some(({ role }) => role === 'source')) invalid('source-node-required');
  if (!nodes.some(({ role }) => role === 'receiver')) invalid('receiver-node-required');

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const contextGraphIds = new Set();
  const contextGraphs = input.contextGraphs.map((entry) => {
    if (contextGraphIds.has(entry.id)) invalid('duplicate-context-graph');
    contextGraphIds.add(entry.id);
    if (!nodeIds.has(entry.sourceNodeId) || !nodeIds.has(entry.receiverNodeId)) {
      invalid('context-graph-node-reference');
    }
    if (entry.sourceNodeId === entry.receiverNodeId) invalid('source-receiver-must-differ');
    const source = nodeById.get(entry.sourceNodeId);
    const receiver = nodeById.get(entry.receiverNodeId);
    if (source.role !== 'source' || receiver.role !== 'receiver') invalid('context-graph-node-role');
    if (entry.vmAskSparql !== undefined) validateAskSparql(entry.vmAskSparql, 'vm');
    if (entry.catalogSwmAskSparql !== undefined) {
      validateAskSparql(entry.catalogSwmAskSparql, 'catalog-swm');
    }
    return Object.freeze({
      ...entry,
      source,
      receiver,
      contextGraphRef: opaqueRef('cg', entry.id),
    });
  });

  const receiverNodeIds = new Set(contextGraphs.map(({ receiverNodeId }) => receiverNodeId));
  if (receiverNodeIds.size !== 1) invalid('exactly-one-receiver-required');
  const receiverNodeId = [...receiverNodeIds][0];
  const lifecycle = input.lifecycle === undefined || input.lifecycle === null
    ? null
    : normalizeLifecycle(input.lifecycle, nodeById, receiverNodeId);
  const authorizationChecks = Object.freeze({
    unauthorized: normalizeAuthorizationCheck(
      input.authorizationChecks.unauthorized,
      'unauthorized',
      nodeById,
    ),
    revoked: normalizeAuthorizationCheck(
      input.authorizationChecks.revoked,
      'revoked',
      nodeById,
    ),
  });
  const rpcUsage = normalizeRpcUsage(input.rpcUsage);
  const timing = normalizeTiming(input.timing);

  return Object.freeze({
    schema: CONFIG_SCHEMA,
    expectedCommit: input.expectedCommit.toLowerCase(),
    nodes: Object.freeze(nodes),
    contextGraphs: Object.freeze(contextGraphs),
    lifecycle,
    authorizationChecks,
    rpcUsage,
    timing,
  });
}

export function createRemoteCanaryCohortRefV1(config) {
  return opaqueRef('cohort', JSON.stringify({
    expectedCommit: config.expectedCommit,
    nodes: config.nodes.map(({ id, role, baseUrl }) => ({ id, role, baseUrl })),
    contextGraphs: config.contextGraphs.map((entry) => ({
      id: entry.id,
      sourceNodeId: entry.sourceNodeId,
      receiverNodeId: entry.receiverNodeId,
    })),
  }));
}

function validateSecretFile(value) {
  if (!isAbsolute(value)) invalid('auth-secret-file-must-be-absolute');
  return value;
}

function validateBaseUrl(value, allowTailscaleHttp) {
  let url;
  try { url = new URL(value); } catch { invalid('node-base-url'); }
  if (url.username || url.password || url.search || url.hash) invalid('node-base-url-credentials-or-query');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.protocol !== 'https:'
    && !(url.protocol === 'http:' && (loopback || allowTailscaleHttp))
  ) invalid('node-base-url-requires-https');
  if (url.pathname !== '/' && url.pathname !== '') invalid('node-base-url-path');
  return url.origin;
}

function normalizeLifecycle(value, nodeById, receiverNodeId) {
  if (!nodeById.has(value.receiverNodeId) || value.receiverNodeId !== receiverNodeId) {
    invalid('lifecycle-receiver-mismatch');
  }
  return Object.freeze({
    receiverNodeId: value.receiverNodeId,
    receiver: nodeById.get(value.receiverNodeId),
    stop: validateCommandV1(value.stop),
    start: validateCommandV1(value.start),
    commandTimeoutMs: value.commandTimeoutMs ?? DEFAULT_LIFECYCLE.commandTimeoutMs,
    stopTimeoutMs: value.stopTimeoutMs ?? DEFAULT_LIFECYCLE.stopTimeoutMs,
    readyTimeoutMs: value.readyTimeoutMs ?? DEFAULT_LIFECYCLE.readyTimeoutMs,
  });
}

function normalizeAuthorizationCheck(value, label, nodeById) {
  if (value.kind === 'not-exposed') {
    const expected = label === 'unauthorized'
      ? 'catalog-protocol-api-not-exposed'
      : 'revocation-api-not-exposed';
    if (value.reasonCode !== expected) invalid('authorization-gap-reason');
    return Object.freeze({ ...value });
  }
  const requiredAuthentication = label === 'unauthorized' ? 'none' : 'node';
  if (value.authentication !== requiredAuthentication) {
    invalid(`${label}-authentication-mode`);
  }
  if (!nodeById.has(value.nodeId)) invalid('authorization-node-reference');
  if (value.path.includes('#') || value.path.startsWith('//')) invalid('authorization-path');
  if (value.method === 'POST' && value.path.split('?')[0] !== '/api/query') {
    invalid('authorization-post-must-be-read-only-query');
  }
  if (value.body !== undefined) assertJsonData(value.body, 'authorization-body');
  if (value.expectedCodes.some((code) => !/^RFC64_[A-Z0-9_]+$/u.test(code))) {
    invalid('authorization-code-not-rfc64-specific');
  }
  if (value.expectedStatuses.includes(404)) {
    if (value.notFoundControlNodeId === undefined) {
      invalid('authorization-404-requires-code-and-control');
    }
    const controlNode = nodeById.get(value.notFoundControlNodeId);
    if (controlNode === undefined || controlNode.auth.kind === 'none') {
      invalid('authorization-404-control-node');
    }
  } else if (value.notFoundControlNodeId !== undefined) {
    invalid('authorization-404-control-without-404');
  }
  const node = nodeById.get(value.nodeId);
  const notFoundControlNode = value.notFoundControlNodeId === undefined
    ? undefined
    : nodeById.get(value.notFoundControlNodeId);
  return Object.freeze({
    ...value,
    node,
    ...(notFoundControlNode === undefined ? {} : { notFoundControlNode }),
    expectedStatuses: Object.freeze([...new Set(value.expectedStatuses)]),
    expectedCodes: Object.freeze([...new Set(value.expectedCodes)]),
  });
}

function normalizeRpcUsage(value) {
  if (value.kind === 'required') return Object.freeze({ kind: 'required' });
  if (value.kind === 'evidence-file') {
    if (!isAbsolute(value.path)) invalid('rpc-evidence-path-must-be-absolute');
    return Object.freeze({
      kind: value.kind,
      path: value.path,
      minimumSamples: value.minimumSamples ?? DEFAULT_RPC_USAGE.minimumSamples,
    });
  }
  return Object.freeze({
    kind: value.kind,
    command: validateCommandV1(value.command),
    minimumSamples: value.minimumSamples ?? DEFAULT_RPC_USAGE.minimumSamples,
    commandTimeoutMs: value.commandTimeoutMs ?? DEFAULT_RPC_USAGE.commandTimeoutMs,
  });
}

function normalizeTiming(value) {
  if (value === undefined) return DEFAULT_TIMING;
  return Object.freeze({ ...DEFAULT_TIMING, ...value });
}

function validateAskSparql(value, label) {
  let parsed;
  try {
    parsed = sparqlParser.parse(value);
  } catch {
    invalid(`${label}-query-must-be-ask`);
  }
  if (parsed.type === 'update') invalid(`${label}-query-must-be-read-only`);
  if (parsed.type !== 'query' || parsed.subType !== 'ask') {
    invalid(`${label}-query-must-be-ask`);
  }
  const patterns = parsed.where?.subType === 'group' ? parsed.where.patterns : [];
  const triples = patterns.flatMap((pattern) => (
    pattern.subType === 'bgp' && Array.isArray(pattern.triples) ? pattern.triples : []
  ));
  if (
    patterns.length === 0
    || patterns.some((pattern) => pattern.subType !== 'bgp' || pattern.triples.length === 0)
    || triples.length === 0
    || !triples.some((triple) => [triple.subject, triple.predicate, triple.object].some(
      (term) => term?.type === 'term' && ['namedNode', 'literal'].includes(term.subType),
    ))
  ) invalid(`${label}-query-must-depend-on-data`);
}

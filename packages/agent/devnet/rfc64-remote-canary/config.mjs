// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  CONFIG_SCHEMA,
  assertJsonData,
  boundedInteger,
  invalid,
  opaqueRef,
} from './common.mjs';
import { matchesJsonSchemaV1 } from './json-schema-v1.mjs';

const DEFAULT_TIMING = Object.freeze({
  requestTimeoutMs: 10_000,
  pollIntervalMs: 2_000,
  propagationTimeoutMs: 120_000,
  catchupTimeoutMs: 240_000,
  parityTimeoutMs: 120_000,
});
const configSchema = JSON.parse(readFileSync(
  new URL('./config.schema.json', import.meta.url),
  'utf8',
));
const rpcEvidenceSchema = JSON.parse(readFileSync(
  new URL('./rpc-usage-evidence.schema.json', import.meta.url),
  'utf8',
));

/**
 * The JSON Schema is the canonical shape contract. Handwritten checks below
 * are limited to cross-references, normalization, and safety semantics.
 */
export function validateRemoteCanaryConfigV1(input) {
  if (!matchesJsonSchemaV1(configSchema, input)) invalid('config-shape');

  const nodeIds = new Set();
  const nodes = input.nodes.map((node) => {
    if (nodeIds.has(node.id)) invalid('duplicate-node-id');
    nodeIds.add(node.id);
    const baseUrl = validateBaseUrl(node.baseUrl, node.allowTailscaleHttp === true);
    const auth = node.auth.kind === 'none'
      ? Object.freeze({ kind: 'none' })
      : Object.freeze({ kind: 'bearer-file', secretFile: validateSecretFile(node.auth.secretFile) });
    return Object.freeze({ ...node, baseUrl, auth });
  });
  if (!nodes.some(({ role }) => role === 'source')) invalid('source-node-required');
  if (!nodes.some(({ role }) => role === 'receiver')) invalid('receiver-node-required');

  const contextGraphIds = new Set();
  const contextGraphs = input.contextGraphs.map((entry) => {
    if (contextGraphIds.has(entry.id)) invalid('duplicate-context-graph');
    contextGraphIds.add(entry.id);
    if (!nodeIds.has(entry.sourceNodeId) || !nodeIds.has(entry.receiverNodeId)) {
      invalid('context-graph-node-reference');
    }
    if (entry.sourceNodeId === entry.receiverNodeId) invalid('source-receiver-must-differ');
    const source = nodes.find(({ id }) => id === entry.sourceNodeId);
    const receiver = nodes.find(({ id }) => id === entry.receiverNodeId);
    if (source.role !== 'source' || receiver.role !== 'receiver') invalid('context-graph-node-role');
    if (entry.vmAskSparql !== undefined) validateAskSparql(entry.vmAskSparql, 'vm');
    if (entry.catalogSwmAskSparql !== undefined) {
      validateAskSparql(entry.catalogSwmAskSparql, 'catalog-swm');
    }
    return Object.freeze({ ...entry });
  });

  const receiverNodeIds = new Set(contextGraphs.map(({ receiverNodeId }) => receiverNodeId));
  if (receiverNodeIds.size !== 1) invalid('exactly-one-receiver-required');
  const receiverNodeId = [...receiverNodeIds][0];
  const lifecycle = input.lifecycle === undefined || input.lifecycle === null
    ? null
    : normalizeLifecycle(input.lifecycle, nodeIds, receiverNodeId);
  const authorizationChecks = Object.freeze({
    unauthorized: normalizeAuthorizationCheck(input.authorizationChecks.unauthorized, 'unauthorized', nodes),
    revoked: normalizeAuthorizationCheck(input.authorizationChecks.revoked, 'revoked', nodes),
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

export function assertRpcEvidenceShapeV1(evidence) {
  if (!matchesJsonSchemaV1(rpcEvidenceSchema, evidence)) {
    throw new Error('rpc-evidence-malformed');
  }
}

export function validateCommandV1(value) {
  for (const arg of value.argv) {
    if (
      /(?:^|[=\s])authorization\s*:\s*(?:bearer|basic)\s+\S+/iu.test(arg)
      || /:\/\/[^/@:]+:[^/@]+@/u.test(arg)
      || /^--?(?:user|password|passwd|token|api[-_]?key|secret|authorization)(?:=|$)/iu.test(arg)
      || /^-(?:u|U)(?:.+)?$/u.test(arg)
      || /^(?:[A-Z0-9_]*_)?(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|AUTHORIZATION)=.+$/iu.test(arg)
    ) invalid('inline-command-secret-rejected');
  }
  return Object.freeze({ argv: Object.freeze([...value.argv]) });
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

function normalizeLifecycle(value, nodeIds, receiverNodeId) {
  if (!nodeIds.has(value.receiverNodeId) || value.receiverNodeId !== receiverNodeId) {
    invalid('lifecycle-receiver-mismatch');
  }
  return Object.freeze({
    receiverNodeId: value.receiverNodeId,
    stop: validateCommandV1(value.stop),
    start: validateCommandV1(value.start),
    commandTimeoutMs: boundedInteger(value.commandTimeoutMs ?? 60_000, 1_000, 120_000),
    stopTimeoutMs: boundedInteger(value.stopTimeoutMs ?? 60_000, 1_000, 120_000),
    readyTimeoutMs: boundedInteger(value.readyTimeoutMs ?? 180_000, 1_000, 300_000),
  });
}

function normalizeAuthorizationCheck(value, label, nodes) {
  if (value.kind === 'not-exposed') {
    const expected = label === 'unauthorized'
      ? 'catalog-protocol-api-not-exposed'
      : 'revocation-api-not-exposed';
    if (value.reasonCode !== expected) invalid('authorization-gap-reason');
    return Object.freeze({ ...value });
  }
  const nodeIds = new Set(nodes.map(({ id }) => id));
  if (!nodeIds.has(value.nodeId)) invalid('authorization-node-reference');
  if (value.path.includes('#') || value.path.startsWith('//')) invalid('authorization-path');
  if (value.method === 'POST' && value.path.split('?')[0] !== '/api/query') {
    invalid('authorization-post-must-be-read-only-query');
  }
  if (value.body !== undefined) assertJsonData(value.body, 'authorization-body');
  if ((value.bodyCodePointer === undefined) !== (value.expectedCodes === undefined)) {
    invalid('authorization-code-pair');
  }
  if (value.expectedCodes?.some((code) => !/^RFC64_[A-Z0-9_]+$/u.test(code))) {
    invalid('authorization-code-not-rfc64-specific');
  }
  if (value.expectedStatuses.includes(404)) {
    if (value.bodyCodePointer === undefined || value.notFoundControlNodeId === undefined) {
      invalid('authorization-404-requires-code-and-control');
    }
    const controlNode = nodes.find(({ id }) => id === value.notFoundControlNodeId);
    if (controlNode === undefined || controlNode.auth.kind === 'none') {
      invalid('authorization-404-control-node');
    }
  } else if (value.notFoundControlNodeId !== undefined) {
    invalid('authorization-404-control-without-404');
  }
  return Object.freeze({
    ...value,
    expectedStatuses: Object.freeze([...new Set(value.expectedStatuses)]),
    ...(value.expectedCodes === undefined
      ? {}
      : { expectedCodes: Object.freeze([...new Set(value.expectedCodes)]) }),
  });
}

function normalizeRpcUsage(value) {
  if (value.kind === 'required') return Object.freeze({ kind: 'required' });
  if (value.kind === 'evidence-file') {
    if (!isAbsolute(value.path)) invalid('rpc-evidence-path-must-be-absolute');
    return Object.freeze({
      kind: value.kind,
      path: value.path,
      minimumSamples: boundedInteger(value.minimumSamples ?? 1, 1, 1440),
    });
  }
  return Object.freeze({
    kind: value.kind,
    command: validateCommandV1(value.command),
    minimumSamples: boundedInteger(value.minimumSamples ?? 1, 1, 1440),
    commandTimeoutMs: boundedInteger(value.commandTimeoutMs ?? 60_000, 1_000, 120_000),
  });
}

function normalizeTiming(value) {
  if (value === undefined) return DEFAULT_TIMING;
  return Object.freeze({
    requestTimeoutMs: boundedInteger(value.requestTimeoutMs ?? 10_000, 1_000, 60_000),
    pollIntervalMs: boundedInteger(value.pollIntervalMs ?? 2_000, 250, 30_000),
    propagationTimeoutMs: boundedInteger(value.propagationTimeoutMs ?? 120_000, 1_000, 300_000),
    catchupTimeoutMs: boundedInteger(value.catchupTimeoutMs ?? 240_000, 1_000, 600_000),
    parityTimeoutMs: boundedInteger(value.parityTimeoutMs ?? 120_000, 1_000, 300_000),
  });
}

function validateAskSparql(value, label) {
  if (/\b(?:INSERT|DELETE|LOAD|CLEAR|CREATE|DROP|MOVE|COPY|ADD|WITH)\b/iu.test(value)) {
    invalid(`${label}-query-must-be-read-only`);
  }
  const match = /^\s*ASK(?:\s+WHERE)?\s*\{([\s\S]*)\}\s*$/iu.exec(value);
  if (match === null) invalid(`${label}-query-must-be-ask`);
  const body = match[1].trim();
  if (body.length === 0) invalid(`${label}-query-must-depend-on-data`);
  const term = '(?:<[^>\\r\\n]+>|[?$][A-Za-z_][A-Za-z0-9_]*|"(?:[^"\\\\]|\\\\.)*"|[^\\s{}]+)';
  const triple = new RegExp(`${term}\\s+${term}\\s+${term}(?:\\s*\\.|\\s*$)`, 'u');
  if (!triple.test(body) || !/(?:<[^>]+>|"(?:[^"\\]|\\.)*")/u.test(body)) {
    invalid(`${label}-query-must-depend-on-data`);
  }
}

// SPDX-License-Identifier: Apache-2.0
// @ts-check

/** @typedef {import('./domain-contract.js').JsonValue} JsonValue */
/** @typedef {import('./domain-contract.js').NormalizedCanaryAuthorizationCheckV1} NormalizedCanaryAuthorizationCheckV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryLifecycleV1} NormalizedCanaryLifecycleV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryNodeV1} NormalizedCanaryNodeV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryRpcUsageV1} NormalizedCanaryRpcUsageV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryTimingV1} NormalizedCanaryTimingV1 */
/** @typedef {import('./domain-contract.js').NormalizedRemoteCanaryConfigV1} NormalizedRemoteCanaryConfigV1 */
/** @typedef {import('./domain-contract.js').RawCanaryAuthorizationCheckV1} RawCanaryAuthorizationCheckV1 */
/** @typedef {import('./domain-contract.js').RawCanaryLifecycleV1} RawCanaryLifecycleV1 */
/** @typedef {import('./domain-contract.js').RawCanaryNodeV1} RawCanaryNodeV1 */
/** @typedef {import('./domain-contract.js').RawCanaryRpcUsageV1} RawCanaryRpcUsageV1 */
/** @typedef {import('./domain-contract.js').RawCanaryTimingV1} RawCanaryTimingV1 */
/** @typedef {import('./domain-contract.js').RawRemoteCanaryConfigV1} RawRemoteCanaryConfigV1 */

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Parser as SparqlParser } from '@traqula/parser-sparql-1-1';

import {
  CANARY_PREDICATE,
  CANARY_SUBJECT_PREFIX,
} from './canary-vocabulary.mjs';
import { validateCommandV1 } from './command-policy.mjs';
import { invalid } from './errors.mjs';
import { opaqueRef } from './references.mjs';

const CONFIG_SCHEMA = 'dkg-rfc64-remote-canary-config-v1';

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
// NodeNext sees these CommonJS-compatible packages as namespaces even though
// their runtime default exports are constructable/callable.
// @ts-expect-error Runtime interop is covered by the configuration tests.
const schemaValidator = new Ajv2020({ allErrors: false, strict: true });
// @ts-expect-error Runtime interop is covered by the configuration tests.
addFormats(schemaValidator);
/** @type {import('ajv').ValidateFunction<RawRemoteCanaryConfigV1>} */
const matchesRemoteCanaryConfigV1 = schemaValidator.compile(configSchema);
const sparqlParser = new SparqlParser();

/**
 * The JSON Schema is the canonical shape contract. Handwritten checks below
 * are limited to cross-references, normalization, and safety semantics.
 */
/**
 * @param {unknown} input
 * @returns {Readonly<NormalizedRemoteCanaryConfigV1>}
 */
export function validateRemoteCanaryConfigV1(input) {
  if (!matchesRemoteCanaryConfigV1(input)) invalid('config-shape');
  const raw = /** @type {RawRemoteCanaryConfigV1} */ (input);

  const nodeIds = new Set();
  const nodes = raw.nodes.map((node) => {
    if (nodeIds.has(node.id)) invalid('duplicate-node-id');
    nodeIds.add(node.id);
    const baseUrl = validateBaseUrl(node.baseUrl, node.allowTailscaleHttp === true);
    const auth = normalizeAuthentication(node.auth);
    return Object.freeze({ ...node, baseUrl, auth, nodeRef: opaqueRef('node', node.id) });
  });
  if (!nodes.some(({ role }) => role === 'source')) invalid('source-node-required');
  if (!nodes.some(({ role }) => role === 'receiver')) invalid('receiver-node-required');

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const contextGraphIds = new Set();
  const contextGraphs = raw.contextGraphs.map((entry) => {
    if (contextGraphIds.has(entry.id)) invalid('duplicate-context-graph');
    contextGraphIds.add(entry.id);
    if (!nodeIds.has(entry.sourceNodeId) || !nodeIds.has(entry.receiverNodeId)) {
      invalid('context-graph-node-reference');
    }
    if (entry.sourceNodeId === entry.receiverNodeId) invalid('source-receiver-must-differ');
    const source = requiredNode(nodeById, entry.sourceNodeId, 'context-graph-node-reference');
    const receiver = requiredNode(nodeById, entry.receiverNodeId, 'context-graph-node-reference');
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
  if (receiverNodeId === undefined) invalid('exactly-one-receiver-required');
  const lifecycle = raw.lifecycle === undefined || raw.lifecycle === null
    ? null
    : normalizeLifecycle(raw.lifecycle, nodeById, receiverNodeId);
  const authorizationChecks = Object.freeze({
    unauthorized: normalizeAuthorizationCheck(
      raw.authorizationChecks.unauthorized,
      'unauthorized',
      nodeById,
    ),
    revoked: normalizeAuthorizationCheck(
      raw.authorizationChecks.revoked,
      'revoked',
      nodeById,
    ),
  });
  const rpcUsage = normalizeRpcUsage(raw.rpcUsage);
  const timing = normalizeTiming(raw.timing);

  return Object.freeze({
    schema: CONFIG_SCHEMA,
    expectedCommit: raw.expectedCommit.toLowerCase(),
    nodes: Object.freeze(nodes),
    contextGraphs: Object.freeze(contextGraphs),
    lifecycle,
    authorizationChecks,
    rpcUsage,
    timing,
  });
}

/**
 * @param {NormalizedRemoteCanaryConfigV1} config
 * @returns {string}
 */
export function createRemoteCanaryCohortRefV1(config) {
  return opaqueRef('cohort', JSON.stringify({
    expectedCommit: config.expectedCommit,
    nodes: config.nodes
      .map(({ id, role, baseUrl }) => ({ id, role, baseUrl }))
      .sort((left, right) => compareCanonicalText(left.id, right.id)),
    contextGraphs: config.contextGraphs
      .map(({ id, sourceNodeId, receiverNodeId }) => ({
        id,
        sourceNodeId,
        receiverNodeId,
      }))
      .sort((left, right) => compareCanonicalText(left.id, right.id)),
  }));
}

/** @param {string} left @param {string} right @returns {number} */
function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {string} value @returns {string} */
function validateSecretFile(value) {
  if (!isAbsolute(value)) invalid('auth-secret-file-must-be-absolute');
  return value;
}

/**
 * @param {import('./domain-contract.js').RawCanaryAuthenticationV1} value
 * @returns {import('./domain-contract.js').RawCanaryAuthenticationV1}
 */
function normalizeAuthentication(value) {
  if (value.kind === 'none') return Object.freeze({ kind: 'none' });
  if (value.kind === 'bearer-file') {
    return Object.freeze({ kind: 'bearer-file', secretFile: validateSecretFile(value.secretFile) });
  }
  return assertNever(value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {Set<object>} [seen]
 * @returns {void}
 */
function assertJsonData(value, field, seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (seen.has(value)) invalid(`${field}-circular`);
    seen.add(value);
    for (const entry of value) assertJsonData(entry, field, seen);
    seen.delete(value);
    return;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) invalid(`${field}-circular`);
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (key.length > 256) invalid(`${field}-key-too-long`);
      assertJsonData(entry, field, seen);
    }
    seen.delete(value);
    return;
  }
  invalid(`${field}-not-json`);
}

/** @param {string} value @param {boolean} allowTailscaleHttp @returns {string} */
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

/**
 * @param {ReadonlyMap<string, NormalizedCanaryNodeV1>} nodeById
 * @param {string} nodeId
 * @param {string} errorCode
 * @returns {NormalizedCanaryNodeV1}
 */
function requiredNode(nodeById, nodeId, errorCode) {
  const node = nodeById.get(nodeId);
  if (node === undefined) invalid(errorCode);
  return node;
}

/**
 * @param {RawCanaryLifecycleV1} value
 * @param {ReadonlyMap<string, NormalizedCanaryNodeV1>} nodeById
 * @param {string} receiverNodeId
 * @returns {Readonly<NormalizedCanaryLifecycleV1>}
 */
function normalizeLifecycle(value, nodeById, receiverNodeId) {
  if (!nodeById.has(value.receiverNodeId) || value.receiverNodeId !== receiverNodeId) {
    invalid('lifecycle-receiver-mismatch');
  }
  return Object.freeze({
    receiverNodeId: value.receiverNodeId,
    receiver: requiredNode(nodeById, value.receiverNodeId, 'lifecycle-receiver-mismatch'),
    stop: validateCommandV1(value.stop),
    start: validateCommandV1(value.start),
    commandTimeoutMs: value.commandTimeoutMs ?? DEFAULT_LIFECYCLE.commandTimeoutMs,
    stopTimeoutMs: value.stopTimeoutMs ?? DEFAULT_LIFECYCLE.stopTimeoutMs,
    readyTimeoutMs: value.readyTimeoutMs ?? DEFAULT_LIFECYCLE.readyTimeoutMs,
  });
}

/**
 * @param {RawCanaryAuthorizationCheckV1} value
 * @param {'unauthorized' | 'revoked'} label
 * @param {ReadonlyMap<string, NormalizedCanaryNodeV1>} nodeById
 * @returns {Readonly<NormalizedCanaryAuthorizationCheckV1>}
 */
function normalizeAuthorizationCheck(value, label, nodeById) {
  if (value.kind === 'not-exposed') {
    const expected = label === 'unauthorized'
      ? 'catalog-protocol-api-not-exposed'
      : 'revocation-api-not-exposed';
    if (value.reasonCode !== expected) invalid('authorization-gap-reason');
    return Object.freeze({ ...value });
  }
  if (value.kind !== 'http') return assertNever(value);
  const requiredAuthentication = label === 'unauthorized' ? 'none' : 'node';
  if (value.authentication !== requiredAuthentication) {
    invalid(`${label}-authentication-mode`);
  }
  const node = requiredNode(nodeById, value.nodeId, 'authorization-node-reference');
  if (label === 'revoked' && node.auth.kind !== 'bearer-file') {
    invalid('revoked-authentication-credentials-required');
  }
  if (value.path.includes('#') || value.path.startsWith('//')) invalid('authorization-path');
  if (value.method === 'POST' && value.path.split('?')[0] !== '/api/query') {
    invalid('authorization-post-must-be-read-only-query');
  }
  if (value.body !== undefined) assertJsonData(value.body, 'authorization-body');
  if (value.expectedCodes.some((code) => !/^RFC64_[A-Z0-9_]+$/u.test(code))) {
    invalid('authorization-code-not-rfc64-specific');
  }
  /** @type {NormalizedCanaryNodeV1 | undefined} */
  let notFoundControlNode;
  if (value.expectedStatuses.includes(404)) {
    if (value.notFoundControlNodeId === undefined) {
      invalid('authorization-404-requires-code-and-control');
    }
    notFoundControlNode = requiredNode(
      nodeById,
      value.notFoundControlNodeId,
      'authorization-404-control-node',
    );
    if (notFoundControlNode.auth.kind === 'none') {
      invalid('authorization-404-control-node');
    }
  } else if (value.notFoundControlNodeId !== undefined) {
    invalid('authorization-404-control-without-404');
  }
  return Object.freeze({
    ...value,
    ...(value.body === undefined ? {} : { body: cloneFrozenJsonObject(value.body) }),
    node,
    ...(notFoundControlNode === undefined ? {} : { notFoundControlNode }),
    expectedStatuses: Object.freeze([...new Set(value.expectedStatuses)]),
    expectedCodes: Object.freeze([...new Set(value.expectedCodes)]),
  });
}

/** @param {RawCanaryRpcUsageV1} value @returns {Readonly<NormalizedCanaryRpcUsageV1>} */
function normalizeRpcUsage(value) {
  switch (value.kind) {
    case 'required':
      return Object.freeze({ kind: 'required' });
    case 'evidence-file':
      if (!isAbsolute(value.path)) invalid('rpc-evidence-path-must-be-absolute');
      return Object.freeze({
        kind: value.kind,
        path: value.path,
        minimumSamples: value.minimumSamples ?? DEFAULT_RPC_USAGE.minimumSamples,
      });
    case 'command':
      return Object.freeze({
        kind: value.kind,
        command: validateCommandV1(value.command),
        minimumSamples: value.minimumSamples ?? DEFAULT_RPC_USAGE.minimumSamples,
        commandTimeoutMs: value.commandTimeoutMs ?? DEFAULT_RPC_USAGE.commandTimeoutMs,
      });
    default:
      return assertNever(value);
  }
}

/** @param {JsonValue} value @returns {JsonValue} */
function cloneFrozenJson(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozenJson));
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneFrozenJson(entry)]),
    ));
  }
  return value;
}

/**
 * @param {Readonly<{ [key: string]: JsonValue }>} value
 * @returns {Readonly<{ [key: string]: JsonValue }>}
 */
function cloneFrozenJsonObject(value) {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneFrozenJson(entry)]),
  ));
}

/**
 * @param {RawCanaryTimingV1 | undefined} value
 * @returns {Readonly<NormalizedCanaryTimingV1>}
 */
function normalizeTiming(value) {
  if (value === undefined) return DEFAULT_TIMING;
  return Object.freeze({ ...DEFAULT_TIMING, ...value });
}

/** @param {string} value @param {'vm' | 'catalog-swm'} label @returns {void} */
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
  const askQuery = /** @type {{ where?: unknown, context?: unknown }} */ (parsed);
  const where = askQuery.where;
  const whereRecord = where !== null && typeof where === 'object' && !Array.isArray(where)
    ? /** @type {Record<string, unknown>} */ (where)
    : null;
  const patterns = whereRecord?.subType === 'group' && Array.isArray(whereRecord.patterns)
    ? whereRecord.patterns
    : [];
  const triples = patterns.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const pattern = /** @type {Record<string, unknown>} */ (candidate);
    return pattern.subType === 'bgp' && Array.isArray(pattern.triples) ? pattern.triples : [];
  });
  const terms = triples.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const triple = /** @type {Record<string, unknown>} */ (candidate);
    if (!('subject' in triple) || !('predicate' in triple) || !('object' in triple)) return [];
    return [triple.subject, triple.predicate, triple.object];
  });
  const nestedTerms = terms.flatMap(collectSparqlTerms);
  const iriContext = resolveSparqlIriContext(
    Array.isArray(askQuery.context) ? askQuery.context : [],
  );
  if (
    patterns.length === 0
    || patterns.some((candidate) => {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return true;
      }
      const pattern = /** @type {Record<string, unknown>} */ (candidate);
      return pattern.subType !== 'bgp'
        || !Array.isArray(pattern.triples)
        || pattern.triples.length === 0;
    })
    || triples.length === 0
    || !terms.some((term) => (
      term !== null
      && typeof term === 'object'
      && !Array.isArray(term)
      && /** @type {Record<string, unknown>} */ (term).type === 'term'
      && ['namedNode', 'literal'].includes(
        String(/** @type {Record<string, unknown>} */ (term).subType),
      )
    ))
  ) invalid(`${label}-query-must-depend-on-data`);
  if (
    label === 'catalog-swm'
    && nestedTerms.some((term) => (
      term?.type === 'term'
      && term.subType === 'namedNode'
      && reservedCanaryIri(resolveNamedNodeIri(term, iriContext))
    ))
  ) invalid('catalog-swm-query-uses-canary-vocabulary');
}

/** @param {unknown} value @returns {Record<string, unknown>[]} */
function collectSparqlTerms(value) {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(collectSparqlTerms);
  const recordValue = /** @type {Record<string, unknown>} */ (value);
  const nested = Object.values(recordValue).flatMap(collectSparqlTerms);
  return recordValue.type === 'term' ? [recordValue, ...nested] : nested;
}

/** @param {readonly unknown[]} entries */
function resolveSparqlIriContext(entries) {
  /** @type {string | undefined} */
  let base;
  const prefixes = new Map();
  for (const candidate of entries) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const entry = /** @type {Record<string, unknown>} */ (candidate);
    const entryValue = entry.value;
    if (entryValue === null || typeof entryValue !== 'object' || Array.isArray(entryValue)) {
      continue;
    }
    const value = /** @type {Record<string, unknown>} */ (entryValue).value;
    if (entry.subType === 'base' && typeof value === 'string') {
      base = resolveIriReference(value, base);
    } else if (
      entry.subType === 'prefix'
      && typeof entry.key === 'string'
      && typeof value === 'string'
    ) {
      prefixes.set(entry.key, resolveIriReference(value, base));
    }
  }
  return Object.freeze({ base, prefixes });
}

/**
 * @param {Record<string, unknown>} term
 * @param {{ base: string | undefined, prefixes: ReadonlyMap<string, string> }} context
 */
function resolveNamedNodeIri(term, context) {
  if (typeof term.value !== 'string') return '';
  if (term.prefix === undefined) return resolveIriReference(term.value, context.base);
  if (typeof term.prefix !== 'string') return term.value;
  const prefix = context.prefixes.get(term.prefix);
  return typeof prefix === 'string' ? `${prefix}${term.value}` : term.value;
}

/** @param {string} value @param {string | undefined} base @returns {string} */
function resolveIriReference(value, base) {
  if (base === undefined) return value;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

/** @param {string} value @returns {boolean} */
function reservedCanaryIri(value) {
  return value === CANARY_PREDICATE || value.startsWith(CANARY_SUBJECT_PREFIX);
}

/** @param {never} value @returns {never} */
function assertNever(value) {
  throw new TypeError(`Unhandled RFC-64 canary discriminant: ${String(value)}`);
}

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { canonicalizeJson, validateContextGraphId, type CanonicalJsonValue } from '@origintrail-official/dkg-core';
import type { SemanticN8nConfig, SemanticN8nGrant, SemanticQueryOutputSchema } from '@origintrail-official/dkg-semantic-runtime';
import { assertSemanticQueryOutput, queryOutputSchemaSha256 } from './semantic-runtime-query-pins.js';

export const N8N_TOOL_IRI = 'urn:dkg:tool:n8n';
export const n8nObservationScope = (graph: string, executor: string, workflow: string): string =>
  'nOS scope ' + createHash('sha256').update(JSON.stringify([graph, executor.toLowerCase(), workflow])).digest('hex').slice(0, 20);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const n8nRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

export function validateN8nGrant(value: unknown): asserts value is SemanticN8nGrant {
  if (!n8nRecord(value) || !closed(value, ['toolIri', 'workflowId', 'workflowSha256', 'inputSchema', 'outputSchema', 'result'])
    || value.toolIri !== N8N_TOOL_IRI || !id(value.workflowId) || !hash(value.workflowSha256)) throw new Error('INVALID_N8N_GRANT');
  queryOutputSchemaSha256(value.inputSchema as SemanticQueryOutputSchema);
  queryOutputSchemaSha256(value.outputSchema as SemanticQueryOutputSchema);
  if (value.result !== undefined) {
    const result = value.result;
    const names = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= max
      && v.every(n => typeof n === 'string' && /^[A-Za-z0-9 _.-]{1,80}$/.test(n)) && new Set(v).size === v.length;
    if (!n8nRecord(result) || !closed(result, ['nodes', 'ports', 'traceNodes', 'sinks', 'allowObservation'])
      || !names(result.nodes, 16) || result.ports !== undefined && !names(result.ports, 4)
      || result.ports !== undefined && result.nodes.length !== 1
      || result.traceNodes !== undefined && !names(result.traceNodes, 16)
      || result.allowObservation !== undefined && typeof result.allowObservation !== 'boolean') throw new Error('INVALID_N8N_GRANT');
    if (result.sinks !== undefined && (result.ports !== undefined || !Array.isArray(result.sinks)
      || result.sinks.length < 1 || result.sinks.length > 16
      || !result.sinks.every(s => n8nRecord(s) && closed(s, ['node', 'port', 'name'])
        && typeof s.node === 'string' && (result.nodes as string[]).includes(s.node)
        && Number.isInteger(s.port) && Number(s.port) >= 0 && Number(s.port) < 4 && names([s.name], 1))
      || new Set(result.sinks.map(s => s.name)).size !== result.sinks.length)) throw new Error('INVALID_N8N_GRANT');
  }
}

export function validateN8nConfig(value: unknown): asserts value is SemanticN8nConfig {
  if (!n8nRecord(value) || !closed(value, ['baseUrl', 'apiTokenFile', 'webhookTokenFile', 'workflows'])
    || typeof value.baseUrl !== 'string'
    || typeof value.apiTokenFile !== 'string' || !isAbsolute(value.apiTokenFile)
    || typeof value.webhookTokenFile !== 'string' || !isAbsolute(value.webhookTokenFile)
    || !Array.isArray(value.workflows) || value.workflows.length > 64) throw new Error('INVALID_N8N_CONFIGURATION');
  let origin: URL;
  try { origin = new URL(value.baseUrl); } catch { throw new Error('INVALID_N8N_CONFIGURATION'); }
  // This PoC installs a local execution service, never a URL chosen by the guest.
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('INVALID_N8N_CONFIGURATION');
  const seen = new Set<string>();
  for (const item of value.workflows) {
    if (!n8nRecord(item) || !closed(item, ['contextGraphId', 'executorAgentAddress', 'workflowId', 'workflowSha256'])
      || typeof item.contextGraphId !== 'string' || !validateContextGraphId(item.contextGraphId).valid
      || typeof item.executorAgentAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(item.executorAgentAddress)
      || !id(item.workflowId) || !hash(item.workflowSha256)) throw new Error('INVALID_N8N_CONFIGURATION');
    const key = JSON.stringify([item.contextGraphId, item.executorAgentAddress.toLowerCase(), item.workflowId]);
    if (seen.has(key)) throw new Error('INVALID_N8N_CONFIGURATION');
    seen.add(key);
  }
}

/** Includes node credential references and all node settings, but no secret values. */
export function n8nWorkflowSha256(value: unknown): string {
  if (!n8nRecord(value) || !Array.isArray(value.nodes) || !n8nRecord(value.connections)
    || (value.settings !== undefined && !n8nRecord(value.settings))) throw new Error('INVALID_N8N_WORKFLOW');
  return createHash('sha256').update(canonicalizeJson({ nodes: value.nodes, connections: value.connections,
    settings: value.settings ?? {} } as CanonicalJsonValue, { maxBytes: 1_048_576, maxDepth: 30 })).digest('hex');
}

/** n8n fills omitted parameter defaults in execution snapshots. Every reviewed
 * value must survive unchanged; graph, node settings and credentials stay exact. */
export function n8nExecutionMatches(source: Record<string, unknown>, executed: unknown): boolean {
  if (!n8nRecord(executed)) return false;
  n8nWorkflowSha256(executed); // Apply the same size/depth bounds to the snapshot.
  const strip = (value: Record<string, unknown>) => ({ ...value, nodes: (value.nodes as Record<string, unknown>[])
    .map(({ parameters: _parameters, ...node }) => node) });
  const subset = (expected: unknown, actual: unknown, depth = 0): boolean => {
    if (depth > 30) return false;
    if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length
      && expected.every((value, index) => subset(value, actual[index], depth + 1));
    if (n8nRecord(expected)) return n8nRecord(actual) && Object.entries(expected)
      .every(([key, value]) => Object.hasOwn(actual, key) && subset(value, actual[key], depth + 1));
    return Object.is(expected, actual);
  };
  return n8nWorkflowSha256(strip(source)) === n8nWorkflowSha256(strip(executed))
    && (source.nodes as Record<string, unknown>[]).every((node, index) =>
      subset(node.parameters, (executed.nodes as Record<string, unknown>[])[index]?.parameters));
}

/** Native snapshots contain normalized parameters, not the immutable definition.
 * The trusted provider's published version and its complete approved digest bind
 * parameters; the execution must name that version and preserve the graph,
 * node types/settings and credential references. No node-specific exceptions.
 */
export function n8nPinnedExecutionMatches(
  source: Record<string, unknown>, execution: Record<string, unknown>,
  approved: Pick<SemanticN8nGrant, 'workflowId' | 'workflowSha256'>,
  acknowledgedVersion: string,
): boolean {
  if (typeof source.versionId !== 'string' || !source.versionId
    || source.versionId !== acknowledgedVersion || execution.workflowVersionId !== acknowledgedVersion
    || execution.workflowId !== approved.workflowId || n8nWorkflowSha256(source) !== approved.workflowSha256
    || !n8nRecord(execution.workflowData)) return false;
  const structural = (value: Record<string, unknown>) => {
    n8nWorkflowSha256(value); // Bound the complete provider snapshot before projecting it.
    return { ...value, nodes: (value.nodes as Record<string, unknown>[])
      .map(({ parameters: _parameters, ...node }) => node) };
  };
  return n8nWorkflowSha256(structural(source)) === n8nWorkflowSha256(structural(execution.workflowData));
}

export function assertN8nValue(schema: SemanticQueryOutputSchema, value: unknown, kind: 'INPUT' | 'OUTPUT'): void {
  try {
    canonicalizeJson(value as CanonicalJsonValue, { maxBytes: 16_384, maxDepth: 12 });
    assertSemanticQueryOutput({ outputSchema: schema, outputSchemaSha256: queryOutputSchemaSha256(schema) }, value);
  } catch { throw new Error(`INVALID_N8N_${kind}`); }
}

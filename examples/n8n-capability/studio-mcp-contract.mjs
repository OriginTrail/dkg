import { canonicalizeJson } from '../../packages/core/dist/index.js';
import { normalizeComponentInput } from './component-registry.mjs';
import { namedMcpInput } from './studio-inputs.mjs';
import { createStudioCompiler } from './studio-definition.mjs';

export const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
export const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
export const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const closed = (v, keys) => record(v) && Object.keys(v).every(k => keys.includes(k));
export const canonical = v => canonicalizeJson(v, { maxBytes: 16_384, maxDepth: 12 });
const allowed = new Set(['edit-fields', 'filter', 'sort', 'limit', 'remove-duplicates', 'split-out', 'aggregate',
  'summarize', 'rename-keys', 'date-time', 'if', 'switch', 'merge', 'merge-fields', 'compare-datasets', 'stop-error']);

// This is a service-to-service development boundary. It never interprets model
// arguments as identity or as evidence of standing authority.
export function mcpActor(session, headers, agentEnabled = false) {
  const actor = session.actor(headers);
  if (headers.origin || actor.role !== 'owner') throw fail('STUDIO_MCP_FORBIDDEN', 403);
  const startedBy = headers['x-nos-workflows-started-by'];
  const extra = ['x-nos-workflows-agent-version', 'x-nos-workflows-tool-digest', 'x-nos-workflows-approval-decision'];
  if (startedBy === undefined) {
    if (extra.some(key => headers[key] !== undefined)) throw fail('STUDIO_MCP_FORBIDDEN', 403);
    return actor;
  }
  const agentVersion = headers[extra[0]], toolDigest = headers[extra[1]], approvalDecisionId = headers[extra[2]];
  if (!agentEnabled || typeof startedBy !== 'string' || !startedBy.startsWith('agent:') || !id(startedBy.slice(6))
    || !id(agentVersion) || !hash(toolDigest) || !id(approvalDecisionId)) throw fail('STUDIO_MCP_FORBIDDEN', 403);
  return { ...actor, startedBy, agentVersion, toolDigest, approvalDecisionId };
}

export function readOnlyDefinition(definition, compiler = createStudioCompiler()) {
  const { profile } = compiler.registry;
  const normalized = compiler.normalizeStudio(definition);
  const reads = normalized.nodes.filter(n => n.componentId === 'dkg-read');
  if (reads.length && (reads.length !== 1 || reads[0].id !== normalized.entryId || !profile?.requiresNosActor
    || profile.workflowTools?.effect !== 'read' || !Array.isArray(profile.workflowTools.readGraphs)
    || !profile.workflowTools.readGraphs.length || profile.workflowTools.readGraphs.length > 32
    || profile.workflowTools.readGraphs.some(g => typeof g !== 'string' || !g || g.length > 256)
    || typeof profile.workflowTools.validateArguments !== 'function'
    || reads[0].params.profileRevision !== profile.revision)) throw fail('STUDIO_READ_PROFILE_REQUIRED');
  if (normalized.nodes.some(n => !allowed.has(n.componentId) && n.componentId !== 'dkg-read'))
    throw fail('STUDIO_WORKFLOW_NOT_READ_ONLY');
  return normalized;
}

export function runInput(value, workflow, compiler = createStudioCompiler()) {
  const { profile } = compiler.registry;
  if (!closed(value, ['kaRef', 'workflowSha256', 'runKey', 'arguments']) || !id(value.runKey)
    || value.kaRef !== workflow.kaRef || value.workflowSha256 !== workflow.grant.workflowSha256 || !record(value.arguments))
    throw fail('STUDIO_INVALID_RUN', 400);
  if (workflow.definition.inputs !== undefined) {
    try { return namedMcpInput(value, workflow, compiler.registry); }
    catch { throw fail('STUDIO_INVALID_ARGUMENTS', 400); }
  }
  // Named scalar parameters, as in #1247. The gateway checks its declared five
  // parameter types; Studio independently bounds the values and applies the entry schema.
  if (Object.entries(value.arguments).some(([key, v]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
    || ['constructor', 'prototype'].includes(key) || !['string', 'number', 'boolean'].includes(typeof v)
    || typeof v === 'number' && !Number.isFinite(v))) throw fail('STUDIO_INVALID_ARGUMENTS', 400);
  canonical(value.arguments);
  const root = workflow.definition.nodes.find(n => n.id === workflow.definition.entryId);
  if (root.componentId === 'dkg-read') profile.workflowTools.validateArguments(value.arguments);
  return normalizeComponentInput(compiler.registry.component(root.componentId), { itemsJson: JSON.stringify([value.arguments]),
    paramsJson: JSON.stringify(root.params), executionId: '' });
}

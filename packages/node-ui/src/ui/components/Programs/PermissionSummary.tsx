import React from 'react';
import type { Approval, RequestedToolPermissions, ProgramReference } from '@origintrail-official/dkg-graph-computer';
import type { DraftChild } from './program-drafts.js';
import type { ProgramAgent, ProgramGraph } from './client.js';
import { JsonViewer } from '../common/JsonViewer.js';

type Scope = { graphId: string; permissions?: RequestedToolPermissions; callers: string[]; children: DraftChild[];
  maxCalls: number; maxConcurrency: number; timeoutMs: number; program?: ProgramReference; tools: string[] };
const stable = (v: unknown): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
function facts(scope: Scope): Record<string, unknown> {
  const p = scope.permissions;
  return {
    'Program version': scope.program ? [scope.program.programIri, scope.program.sourceHash, scope.program.authorAgentAddress, scope.program.programLayer, scope.program.graphId] : null,
    'Data graph': scope.graphId,
    'Execution storage': p?.executionLayer ?? 'wm',
    'SPARQL read access': !!p?.sparqlRead,
    'Read tool binding': p?.sparqlRead?.toolIri ?? null,
    'Read memory layer': p?.sparqlRead?.layer ?? null,
    'Read result limit': p?.sparqlRead?.maxResultItems ?? null,
    'Read byte limit': p?.sparqlRead?.maxOutputBytes ?? null,
    'Read timeout (ms)': p?.sparqlRead?.timeoutMs ?? null,
    'Read output schema': p?.sparqlRead?.outputSchema ?? null,
    'Saved query': p?.query ?? null,
    'Create Knowledge Assets': p?.assetCreation ?? null,
    'Requested tools': [...scope.tools].sort(),
    'Allowed callers': [...new Set(scope.callers.map(c => c.toLowerCase()))].sort(),
    'Child Programs': [...scope.children].sort((a,b) => stable(a).localeCompare(stable(b))),
    'Call limit': scope.maxCalls, 'Concurrency': scope.maxConcurrency, 'Timeout': scope.timeoutMs,
  };
}
function previousScope(approval: Approval): Scope {
  const b = approval.binding;
  return { graphId: b.contextGraphId, permissions: { graphId: b.contextGraphId, executionLayer: b.executionLayer,
    ...(b.sparqlRead ? { sparqlRead: { toolIri: b.sparqlRead.toolIri, layer: b.sparqlRead.layer, timeoutMs: b.sparqlRead.timeoutMs,
      maxResultItems: b.sparqlRead.maxResultItems, maxOutputBytes: b.sparqlRead.maxOutputBytes, outputSchema: b.sparqlRead.outputSchema } } : {}),
    ...(b.query ? { query: { selector: b.query.selector, outputSchema: b.query.outputSchema } } : {}),
    ...(b.assetCreation ? { assetCreation: { toolIri: b.assetCreation.toolIri } } : {}) },
    callers: b.allowedCallerAgentAddresses, children: (b.typescript?.children ?? []).map(c => ({ graphId: c.contextGraphId, operationIri: c.operationIri, programIri: c.programIri })),
    maxCalls: b.typescript?.maxCalls ?? 64, maxConcurrency: b.typescript?.maxConcurrency ?? 4, timeoutMs: b.typescript?.timeoutMs ?? 30000,
    tools: b.typescript?.requiredTools ?? [], program: { ...b.program, graphId: b.program.contextGraphId } };
}
export function approvalMatchesScope(scope: Scope, approval: Approval): boolean {
  const current = facts(scope), before = facts(previousScope(approval));
  return Object.keys(current).every(key => stable(current[key]) === stable(before[key]));
}
export default function PermissionSummary({ scope, previous, checked, graphs, agents, invalid }: {
  scope: Scope; previous?: Approval | null; checked: boolean; graphs: ProgramGraph[]; agents: ProgramAgent[]; invalid?: string;
}) {
  const graphName = (id: string) => graphs.find(g => g.id.replace(/^did:dkg:context-graph:/, '') === id)?.name ?? 'Selected graph';
  const agentName = (id: string) => agents.find(a => a.address.toLowerCase() === id.toLowerCase())?.name ?? `${id.slice(0, 8)}…${id.slice(-4)}`;
  const now = facts(scope), before = previous ? facts(previousScope(previous)) : null;
  const changed = before ? Object.keys(now).filter(key => stable(now[key]) !== stable(before[key])) : [];
  const p = scope.permissions;
  function describeChange(label: string) {
    const old = before![label], next = now[label];
    if (label === 'Allowed callers') return `Callers: ${(old as string[]).map(agentName).join(', ') || 'none'} → ${(next as string[]).map(agentName).join(', ') || 'none'}`;
    if (label === 'Data graph') return `Data graph: ${graphName(String(old))} → ${graphName(String(next))}`;
    if (typeof old === 'number' || typeof next === 'number') return `${label}: ${old ?? 'none'} → ${next ?? 'none'}`;
    if (label === 'SPARQL read access') return next ? 'SPARQL read access added' : 'SPARQL read access removed';
    if (label === 'Create Knowledge Assets') return !old ? 'Knowledge Asset creation added' : !next ? 'Knowledge Asset creation removed' : 'Knowledge Asset creation tool changed';
    if (label === 'Saved query') return !old ? 'Saved-query access added' : !next ? 'Saved-query access removed' : 'Selected saved query or its output schema changed';
    if (label === 'Child Programs') return `Child Program selection changed (${(old as unknown[]).length} → ${(next as unknown[]).length})`;
    if (label === 'Read memory layer' || label === 'Execution storage') return `${label}: ${old ?? 'none'} → ${next ?? 'none'}`;
    return `${label} changed`;
  }
  return <section className="program-permission-summary" aria-label="Permission summary">
    <h4>Permission summary</h4>
    {invalid ? <p role="alert">{invalid}</p> : <ul>
      <li>Data access: <strong>{graphName(scope.graphId)}</strong>.</li>
      {p?.sparqlRead && <li>Read SPARQL in {p.sparqlRead.layer.toUpperCase()}: up to {p.sparqlRead.maxResultItems} results, {p.sparqlRead.maxOutputBytes.toLocaleString()} bytes, {p.sparqlRead.timeoutMs / 1000}s per read.</li>}
      {p?.query && <li>Run one selected saved query, with its approved output schema.</li>}
      {p?.assetCreation && <li>Create Knowledge Assets in {(p.executionLayer ?? 'wm').toUpperCase()} on this graph.</li>}
      {!p?.sparqlRead && !p?.query && !p?.assetCreation && <li>No direct tool access requested.</li>}
      <li>{scope.children.length ? `Invoke ${scope.children.length} selected child Program${scope.children.length === 1 ? '' : 's'} using their current approvals.` : 'No child Programs requested.'}</li>
      <li>Callers: {scope.callers.length ? scope.callers.map(agentName).join(', ') : 'none — nobody can invoke'}.</li>
      <li>Up to {scope.maxCalls} calls, {scope.maxConcurrency} at once; {scope.timeoutMs / 1000}s execution timeout.</li>
    </ul>}
    <h4>{previous ? `Changes since approval ${previous.revision}` : 'Approval review'}</h4>
    {!checked ? <p>Checking the current approval…</p> : !previous ? <p>New approval. The permissions above will be granted when you approve.</p>
      : !previous.binding.enabled ? <p>The previous approval is disabled. Approving enables execution again.</p> : null}
    {before && (changed.length ? <ul>{changed.map(label => <li key={label}>{describeChange(label)}.</li>)}</ul> : <p>No permission or Program version changes.</p>)}
    {before && changed.length > 0 && <details><summary>Advanced · exact approval changes</summary><JsonViewer value={Object.fromEntries(changed.map(k => [k, { previous: before[k], requested: now[k] }]))} label="Approval changes" /></details>}
    <p className="program-editor-help">Approval pins this saved version and the selected child approvals. Saving a draft or Program does not grant access.</p>
  </section>;
}

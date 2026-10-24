import { createHash } from 'node:crypto';
import { canonicalizeJson, type CanonicalJsonValue } from '@origintrail-official/dkg-core';
import type { SemanticN8nGrant } from '@origintrail-official/dkg-semantic-runtime';
import { n8nRecord } from './semantic-runtime-n8n-contract.js';

/** Only explicitly selected native nodes can contribute output or diagnostics. */
export function collectN8nExecutionResult(grant: SemanticN8nGrant, execution: Record<string, unknown>): Record<string, unknown> {
  if (!grant.result || !n8nRecord(execution.data) || !n8nRecord(execution.data.resultData)
    || !n8nRecord(execution.data.resultData.runData)) throw new Error('N8N_EXECUTION_DATA_MISSING');
  const runData = execution.data.resultData.runData;
  const runs = (name: string): Record<string, unknown>[] => {
    const values = runData[name];
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.length > 256 || !values.every(n8nRecord)) throw new Error('N8N_EXECUTION_DATA_INVALID');
    return values;
  };
  const outputs = (name: string): unknown[][] => {
    const last = runs(name).at(-1);
    if (!last || !n8nRecord(last.data)) return [];
    const main = last.data.main;
    if (!Array.isArray(main) || main.length > 4) throw new Error('N8N_EXECUTION_DATA_INVALID');
    return main.map(port => {
      if (port === null) return [];
      if (!Array.isArray(port) || port.length > 200) throw new Error('N8N_EXECUTION_DATA_INVALID');
      return port.map(item => {
        if (!n8nRecord(item) || !n8nRecord(item.json)) throw new Error('N8N_EXECUTION_DATA_INVALID');
        return item.json;
      });
    });
  };
  const failed = execution.status === 'error';
  const sinks = grant.result.sinks;
  const selected = sinks ? sinks.flatMap(s => outputs(s.node)[s.port] ?? []) : grant.result.nodes.flatMap(name => outputs(name)[0] ?? []);
  const ports = sinks && sinks.length > 1 ? Object.fromEntries(sinks.map(s => [s.name, outputs(s.node)[s.port] ?? []])) : grant.result.ports && grant.result.ports.length > 1
    ? Object.fromEntries(grant.result.ports.map((name, i) => [name, outputs(grant.result!.nodes[0]!)[i] ?? []])) : {};
  const itemsJson = JSON.stringify(Object.keys(ports).length ? [] : selected), portsJson = JSON.stringify(ports);
  const oversized = itemsJson.length > 8192 || portsJson.length > 8192
    || selected.length > 20 || Object.values(ports).some(port => port.length > 20);
  const result: Record<string, unknown> = { ok: !failed && !oversized,
    itemsJson: failed || oversized ? '[]' : itemsJson,
    portsJson: failed || oversized ? '{}' : portsJson,
    error: failed ? 'The native n8n component rejected input or stopped this workflow.'
      : oversized ? 'The component output exceeds the PoC limit of twenty records and 8 KiB.' : '' };
  if (grant.result.traceNodes) {
    result.traceJson = JSON.stringify(grant.result.traceNodes.map(name => {
      const records = runs(name), main = outputs(name);
      return { node: name, status: !records.length ? 'skipped' : records.some(r => r.error) ? 'failed' : 'completed',
        items: main.map(port => port.length),
        outputHash: createHash('sha256').update(canonicalizeJson(main as CanonicalJsonValue, { maxBytes: 1_048_576, maxDepth: 30 })).digest('hex') };
    }));
  }
  return result;
}

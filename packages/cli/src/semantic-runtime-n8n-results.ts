import { createHash } from 'node:crypto';
import { canonicalizeJson, type CanonicalJsonValue } from '@origintrail-official/dkg-core';
import { type NativeN8nResultProjection, N8N_VALUE_MAX_BYTES, n8nRecord } from './semantic-runtime-n8n-contract.js';

/** Only explicitly selected native nodes can contribute output or diagnostics. */
export function collectN8nExecutionResult(projection: NativeN8nResultProjection, execution: Record<string, unknown>): Record<string, unknown> {
  if (!n8nRecord(execution.data) || !n8nRecord(execution.data.resultData)
    || !n8nRecord(execution.data.resultData.runData)) throw new Error('N8N_EXECUTION_DATA_MISSING');
  const runData = execution.data.resultData.runData;
  const runs = (name: string): Record<string, unknown>[] => {
    const values = runData[name];
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.length > 256 || !values.every(n8nRecord)) throw new Error('N8N_EXECUTION_DATA_INVALID');
    return values;
  };
  const omitted = new Set<string>(), counts = new Map<string, number[]>(), collected = new Map<string, unknown[][]>();
  const outputs = (name: string): unknown[][] => {
    const cached = collected.get(name);
    if (cached) return cached;
    const result: unknown[][] = [], sizes: number[] = [];
    // Terminal branches can emit on every iteration. Preserve run order and port
    // identity: a Loop Over Items done port already contains its completed batch.
    for (const run of runs(name)) {
      if (!n8nRecord(run.data)) continue;
      const main = run.data.main;
      if (!Array.isArray(main) || main.length > 4) throw new Error('N8N_EXECUTION_DATA_INVALID');
      main.forEach((port, index) => {
        result[index] ??= []; sizes[index] ??= 0;
        if (port === null) return;
        if (!Array.isArray(port)) throw new Error('N8N_EXECUTION_DATA_INVALID');
        const count = sizes[index]! + port.length; sizes[index] = count;
        // Bound retained records across all runs, while counting omitted output.
        if (count > 200) { omitted.add(name); result[index] = []; return; }
        for (const item of port) {
          if (!n8nRecord(item) || !n8nRecord(item.json)) throw new Error('N8N_EXECUTION_DATA_INVALID');
          result[index]!.push(item.json);
        }
      });
    }
    counts.set(name, sizes); collected.set(name, result);
    return result;
  };
  const failed = ['error', 'canceled', 'crashed'].includes(String(execution.status));
  const selected = projection.selectors.map(({ node, port, name }) => [name, outputs(node)[port] ?? []] as const);
  const items = projection.presentation === 'items' ? selected.flatMap(([, records]) => records) : [];
  const ports = projection.presentation === 'ports' ? Object.fromEntries(selected) : {};
  const recordCount = selected.reduce((sum, [, records]) => sum + records.length, 0);
  const itemsJson = JSON.stringify(items), portsJson = JSON.stringify(ports);
  const trace = projection.traceNodes?.map(name => {
    const records = runs(name), main = outputs(name);
    return { node: name, status: !records.length ? 'skipped' : records.some(r => r.error) ? 'failed' : 'completed',
      items: counts.get(name) ?? [],
      ...(omitted.has(name) ? { outputOmitted: 'record-limit' } : { outputHash: createHash('sha256').update(canonicalizeJson(main as CanonicalJsonValue, { maxBytes: 1_048_576, maxDepth: 30 })).digest('hex') }) };
  });
  const oversized = omitted.size > 0 || Buffer.byteLength(itemsJson) > 8192 || Buffer.byteLength(portsJson) > 8192
    || recordCount > 20;
  const result: Record<string, unknown> = { ok: !failed && !oversized,
    itemsJson: failed || oversized ? '[]' : itemsJson,
    portsJson: failed || oversized ? '{}' : portsJson,
    error: failed ? 'The native n8n component rejected input or stopped this workflow.'
      : oversized ? 'The component output exceeds the PoC limit of twenty records and 8 KiB.' : '' };
  if (trace) result.traceJson = JSON.stringify(trace);
  // JSON strings are escaped again in the contract envelope. Check its complete
  // UTF-8 budget, including diagnostics, before schema validation. A completed
  // provider execution with oversized output is a confirmed rejection.
  if (Buffer.byteLength(JSON.stringify(result)) > N8N_VALUE_MAX_BYTES) {
    Object.assign(result, { ok: false, itemsJson: '[]', portsJson: '{}',
      error: 'The component output exceeds the PoC limit of 16 KiB for the complete result.' });
    if (Buffer.byteLength(JSON.stringify(result)) > N8N_VALUE_MAX_BYTES) result.traceJson = '[]';
  }
  return result;
}

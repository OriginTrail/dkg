import React from 'react';
import type { ProgramExecutionTrace, MemoryLayer } from '@origintrail-official/dkg-graph-computer';
import { JsonText } from '../common/JsonViewer.js';
const toolNames: Record<string, string> = { 'urn:dkg:tool:sparql-read': 'SPARQL read', 'urn:dkg:tool:query': 'Saved query', 'urn:dkg:tool:asset-create': 'Create Knowledge Asset' };
export default function ExecutionTrace({ trace, layer, onExecution }: { trace: ProgramExecutionTrace; layer: MemoryLayer; onExecution?: (iri: string, layer: MemoryLayer) => void }) {
  return <section className="program-execution-trace" aria-label="Execution trace">
    <h4>Execution trace <span>{trace.status}{trace.durationMs === undefined ? '' : ` · ${trace.durationMs} ms`}</span></h4>
    <p className="program-editor-help">Calls in this Program, in dispatch order. Durations include authorization and execution. Interrupted calls may still have effects; their outcome is unknown.</p>
    {!trace.calls.length && <p>No tool or child calls were dispatched.</p>}
    <ol>{trace.calls.map(call => <li key={call.id} className={`program-trace-${call.status}`}>
      <details open={call.status === 'failed' || call.status === 'interrupted'}>
        <summary><strong>{call.kind === 'tool' ? (toolNames[call.target] ?? 'Tool call') : 'Child Program'}</strong><span>{call.status} · {call.durationMs === undefined ? 'duration unavailable' : `${call.durationMs} ms`}</span></summary>
        {call.error && <p role="alert">Failure at {call.kind} call #{call.id}: {call.error}</p>}
        {Object.hasOwn(call, 'result') && <JsonText text={JSON.stringify(call.result) ?? 'null'} label={`Call ${call.id} result`} />}
        {call.resultTruncated && <p className="program-editor-help">Result preview truncated to keep the trace bounded.</p>}
        <details><summary>Advanced · call identifiers</summary><p className="program-editor-reference">Call {call.id}: <code>{call.target}</code></p><p>Started {call.startedAt}</p>
          {call.executionIri && <p className="program-editor-reference">Child execution: <code>{call.executionIri}</code></p>}</details>
        {call.executionIri && onExecution && <button type="button" onClick={() => onExecution(call.executionIri!, layer)}>Open child execution</button>}
      </details>
    </li>)}</ol>
    {trace.failure && <p role="alert">{trace.failure.location}: {trace.failure.message}</p>}
  </section>;
}

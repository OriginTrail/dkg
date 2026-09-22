import React, { useEffect, useState } from 'react';
import type { Approval } from '@origintrail-official/dkg-graph-computer';
import { programClient, type ProgramGraph } from './client.js';
import { CopyCall } from './ToolPicker.js';

export type ChildProgram = { graphId: string; operationIri: string; programIri: string };
export default function ChildProgramPicker({ address, graphId, graphs, children, onChange }: {
  address: string; graphId: string; graphs: ProgramGraph[]; children: ChildProgram[]; onChange(value: ChildProgram[]): void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedGraph, setSelectedGraph] = useState(graphId);
  const [search, setSearch] = useState('');
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [status, setStatus] = useState('');
  useEffect(() => { setSelectedGraph(graphId); }, [graphId]);
  useEffect(() => {
    let active = true; setApprovals([]);
    if (!open || !address) return;
    setStatus('Loading approved Programs…');
    programClient(address).then(client => client.programs.listApprovals({ graphId: selectedGraph })).then(values => {
      if (!active) return;
      const enabled = values.filter(value => value.binding.enabled);
      setApprovals(enabled); setStatus(enabled.length ? '' : 'No approved Programs in this graph.');
    }).catch(cause => { if (active) setStatus(`Could not load approvals: ${cause instanceof Error ? cause.message : String(cause)}`); });
    return () => { active = false; };
  }, [open, address, selectedGraph]);
  return <section aria-label="Child Program picker">
    <p className="program-editor-help">Choose an approved operation on this node. Its current approval will be checked and pinned when you approve this Program.</p>
    {children.map((child, index) => <section className="program-tool-card" key={`${index}:${child.programIri}`}>
      <div className="program-tool-heading"><strong className="program-editor-reference">{child.programIri || 'Child Program'}</strong><button type="button" aria-label={`Remove child ${index + 1}`} onClick={() => onChange(children.filter((_, i) => i !== index))}>Remove</button></div>
      <p className="program-editor-reference">{graphs.find(graph => graph.id === child.graphId)?.name ?? child.graphId}<br />{child.operationIri || 'Select the child’s approved operation before approval.'}</p>
      <CopyCall code={`import { invoke_program } from '@origintrail-official/dkg-graph-computer/program';\n\n// Inside your async run() function; replace [] with the child’s arguments:\nconst result = await invoke_program(${JSON.stringify(child.programIri)}, []);`} />
      <details><summary>Advanced · child identifiers</summary>{(['programIri', 'graphId', 'operationIri'] as const).map(field => <label key={field}>{field === 'programIri' ? 'Child Program IRI' : field === 'graphId' ? 'Child graph' : 'Child operation IRI'}
        <input value={child[field]} onChange={event => onChange(children.map((row, i) => i === index ? { ...row, [field]: event.target.value } : row))} /></label>)}</details>
    </section>)}
    <button type="button" disabled={!address || children.length >= 32} onClick={() => setOpen(!open)}>+ Add child Program</button>
    {open && <div className="program-tool-menu">
      <label>Child operation graph<select value={selectedGraph} onChange={event => setSelectedGraph(event.target.value)}>
        {!graphs.some(graph => graph.id === selectedGraph) && <option value={selectedGraph}>{selectedGraph}</option>}
        {graphs.map(graph => <option key={graph.id} value={graph.id}>{graph.name}</option>)}
      </select></label>
      <label>Find an approved Program<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Program or operation IRI" /></label>
      {status && <p className="program-editor-help" role="status">{status}</p>}
      {approvals.filter(value => `${value.binding.program.programIri} ${value.operationIri}`.toLowerCase().includes(search.toLowerCase())).map(value => {
        const child = { graphId: value.contextGraphId, operationIri: value.operationIri, programIri: value.binding.program.programIri };
        const index = children.findIndex(existing => existing.programIri === child.programIri);
        const selected = index >= 0 && children[index].graphId === child.graphId && children[index].operationIri === child.operationIri;
        return <button type="button" className="program-tool-option" key={value.operationIri} disabled={selected} onClick={() => {
          onChange(index >= 0 ? children.map((old, i) => i === index ? child : old) : [...children, child]); setOpen(false);
        }}><strong>{child.programIri}</strong><span>{child.operationIri} · revision {value.revision}{selected ? ' · selected' : ''}</span></button>;
      })}
      <details><summary>Enter identifiers manually</summary><button type="button" onClick={() => { onChange([...children, { graphId: selectedGraph, operationIri: '', programIri: '' }]); setOpen(false); }}>Add manually</button></details>
    </div>}
  </section>;
}

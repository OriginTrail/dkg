import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { Approval, GraphComputer, PreparedInvocation, ProgramReference, Execution, MemoryLayer } from '@origintrail-official/dkg-graph-computer';
import { createUuid } from '@origintrail-official/dkg-graph-computer';
import { programClient, fetchProgramAgents, type ProgramAgent } from './client.js';
import { useModalDismiss } from '../Modals/useModalDismiss.js';
import './program-editor.css';

const Editor = lazy(() => import('./TypeScriptEditor.js'));
const TEMPLATE = `import { pipe, map, reduce } from '@origintrail-official/dkg-graph-computer/program';

export async function run(values: number[]) {
  return pipe(values,
    map(value => Number(value) * 2),
    reduce((sum, value) => Number(sum) + Number(value), 0),
  );
}
`;
type Recovery = PreparedInvocation & { bindingDigest: string };
const canonicalGraph = (value: string) => value.trim().replace(/^did:dkg:context-graph:/, '');
function matchesProgram(approval: Approval, program: ProgramReference) {
  const pin = approval.binding.program;
  return pin.programIri === program.programIri && pin.contextGraphId === canonicalGraph(program.graphId)
    && pin.programLayer === program.programLayer && pin.sourceHash === program.sourceHash
    && pin.authorAgentAddress.toLowerCase() === program.authorAgentAddress.toLowerCase();
}
type Child = { graphId: string; operationIri: string; programIri: string };
type Saved = { name: string; program: ProgramReference; source: string; version: string; children: string[] };
export interface ProgramEditorProps {
  contextGraphId: string;
  existing?: { programIri: string; programLayer: MemoryLayer; label?: string };
  onClose(): void;
  onSaved(): void;
  onExecution?(iri: string, layer: MemoryLayer): void;
}

export default function ProgramEditor({ contextGraphId, existing, onClose, onSaved, onExecution }: ProgramEditorProps) {
  const [agents, setAgents] = useState<ProgramAgent[]>([]);
  const [address, setAddress] = useState('');
  const [name, setName] = useState(existing?.label ?? 'Untitled Program');
  const [source, setSource] = useState(existing ? '' : TEMPLATE);
  const [version, setVersion] = useState('1.0.0');
  const [graphId, setGraphId] = useState(contextGraphId);
  const [operationIri, setOperationIri] = useState('');
  const [callers, setCallers] = useState(address ?? '');
  const [children, setChildren] = useState<Child[]>([]);
  const [maxCalls, setMaxCalls] = useState(64);
  const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [inputs, setInputs] = useState('[[1, 2, 3]]');
  const [saved, setSaved] = useState<Saved | null>(null);
  const [reviewed, setReviewed] = useState<{ key: string; value: Approval | null } | null>(null);
  const [approved, setApproved] = useState<Approval | null>(null);
  const [invocation, setInvocation] = useState<Recovery | null>(null);
  const [result, setResult] = useState<Execution | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const saveAttempt = useRef<{ fingerprint: string; programIri: string; name: string } | null>(null);
  const key = JSON.stringify([canonicalGraph(graphId), operationIri.trim()]);
  const childIris = [...new Set(children.map(child => child.programIri.trim()))].sort();
  const dirty = (!existing && !saved) || (!!saved && (name !== saved.name || source !== saved.source || version !== saved.version || JSON.stringify(childIris) !== JSON.stringify(saved.children)));
  const canRun = !!approved?.binding.enabled && !dirty && approved.contextGraphId === canonicalGraph(graphId)
    && approved.operationIri === operationIri.trim() && !!saved && matchesProgram(approved, saved.program);
  const recoveryKey = `dkg-program-invocation:${location.origin}:${address?.toLowerCase()}:${key}`;

  useEffect(() => {
    generation.current++;
    setCallers(address);
    setSaved(null);
    setSource(existing ? '' : TEMPLATE);
    setName(existing?.label ?? 'Untitled Program');
    setVersion('1.0.0'); setChildren([]);
    saveAttempt.current = null;
    setApproved(null); setReviewed(null); setResult(null); setBusy('');
    return () => { generation.current++; };
  }, [address, contextGraphId, existing?.programIri, existing?.programLayer]);
  useEffect(() => {
    let active = true;
    fetchProgramAgents().then(value => {
      if (!active) return;
      setAgents(value.agents);
      const selected = value.agents.find(a => a.address.toLowerCase() === value.defaultAddress.toLowerCase());
      setAddress(selected?.address ?? '');
      if (!value.agents.length) setError('No agent key is available to this node session.');
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (address && existing) void loadSource(false);
  }, [address, contextGraphId, existing?.programIri, existing?.programLayer]);
  useEffect(() => {
    setApproved(null); setReviewed(null); setResult(null);
    try {
      const raw = sessionStorage.getItem(recoveryKey);
      const value = raw ? JSON.parse(raw) : null;
      setInvocation(value && value.graphId === canonicalGraph(graphId) && value.operationIri === operationIri.trim() && typeof value.bindingDigest === 'string' ? value : null);
    } catch { setInvocation(null); }
  }, [recoveryKey]);
  const close = useCallback(() => {
    if (busy) return;
    if (source && dirty && !window.confirm('Discard the unsaved Program changes?')) return;
    onClose();
  }, [busy, dirty, source, onClose]);
  const { dialogRef, onBackdropClick } = useModalDismiss(true, close);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (dirty && source) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty, source]);

  async function action(label: string, work: (client: GraphComputer, check: () => void) => Promise<void>) {
    const epoch = generation.current;
    const check = () => { if (generation.current !== epoch) throw new Error('Agent changed or editor closed.'); };
    setBusy(label); setError(''); setNotice('');
    try { const client = await programClient(address); check(); await work(client, check); }
    catch (cause) { if (generation.current === epoch) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (generation.current === epoch) setBusy(''); }
  }
  const invalidate = () => { setApproved(null); setResult(null); };
  const operation = () => ({ graphId: canonicalGraph(graphId), operationIri: operationIri.trim() });

  const loadSource = (confirm = true) => {
    if (confirm && source && dirty && !window.confirm('Discard the unsaved Program changes and reload stored source?')) return;
    return action('Loading source…', async (client, check) => {
    const value = await client.programs.getSource({ graphId: contextGraphId, ...existing! }); check();
    if (value.language !== 'typescript-v1') throw new Error('This editor supports TypeScript Programs.');
    const loadedName = value.label ?? existing?.label ?? value.programIri;
    setName(loadedName); setSource(value.source); setVersion(value.version);
    setChildren(value.permittedPrograms.map(programIri => ({ graphId, operationIri: '', programIri })));
    setSaved({ name: loadedName, source: value.source, version: value.version, children: [...value.permittedPrograms].sort(),
      program: { graphId: value.contextGraphId, programIri: value.programIri, programLayer: value.layer,
        sourceHash: value.sourceHash, authorAgentAddress: value.authorAgentAddress } });
    invalidate(); setNotice('Source loaded. Saving creates a new Program version.');
    });
  };

  const save = () => action('Saving new version…', async (client, check) => {
    if (!name.trim()) throw new Error('Give the Program a name.');
    if (!source.trim()) throw new Error('Write a Program first.');
    if (new TextEncoder().encode(source).length > 262144) throw new Error('Source exceeds 256 KiB.');
    if (childIris.some(iri => !iri) || childIris.length !== children.length) throw new Error('Each child needs a distinct Program IRI.');
    const fingerprint = JSON.stringify([name.trim(), source, version, childIris]);
    if (saveAttempt.current?.fingerprint !== fingerprint) {
      const id = createUuid();
      saveAttempt.current = { fingerprint, programIri: `urn:dkg:program:${id}`, name: `${name.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 100) || 'program'}-${id}` };
    }
    const attempt = saveAttempt.current!;
    const value = await client.programs.upload({ graphId: contextGraphId, source, version, language: 'typescript-v1',
      requiredTools: [], permittedPrograms: childIris, programIri: attempt.programIri, name: attempt.name, label: name.trim(),
      derivedFrom: saved?.program.programIri ?? existing?.programIri }); check();
    setSaved({ name, program: value, source, version, children: childIris }); invalidate();
    setNotice('Saved in Working Memory. Execution permission has not changed.');
    onSaved();
  });

  const inspect = () => action('Checking approval…', async (client, check) => {
    let value: Approval | null;
    try { value = await client.programs.getApproval(operation()); }
    catch (cause) { if ((cause as { status?: number }).status === 404) value = null; else throw cause; }
    check(); setReviewed({ key, value }); setApproved(null);
    if (value?.binding.enabled && saved && matchesProgram(value, saved.program) && value.binding.typescript) {
      setApproved(value);
      setCallers(value.binding.allowedCallerAgentAddresses.join('\n'));
      setChildren(value.binding.typescript.children.map(child => ({ graphId: child.contextGraphId, operationIri: child.operationIri, programIri: child.programIri })));
      setMaxCalls(value.binding.typescript.maxCalls); setMaxConcurrency(value.binding.typescript.maxConcurrency); setTimeoutMs(value.binding.typescript.timeoutMs);
    }
    setNotice(value ? 'Current approval loaded. Review it before replacing it.' : 'No approval exists for this operation.');
  });

  const approve = () => action('Compiling and approving…', async (client, check) => {
    if (!saved || dirty || reviewed?.key !== key) throw new Error('Save the source and check the current approval first.');
    const pins = [];
    for (const child of children) {
      const approval = await client.programs.getApproval({ graphId: child.graphId.trim(), operationIri: child.operationIri.trim() }); check();
      if (!approval.binding.enabled || approval.binding.program.programIri !== child.programIri.trim()) throw new Error('A child operation does not match the declared Program.');
      pins.push({ graphId: child.graphId.trim(), operationIri: child.operationIri.trim(), programIri: child.programIri.trim(), bindingDigest: approval.bindingDigest });
    }
    const request = { ...operation(), program: saved.program, allowedCallers: callers.split(/[\s,]+/).filter(Boolean),
      typescript: { children: pins, maxCalls, maxConcurrency, timeoutMs } };
    const value = reviewed.value
      ? await client.programs.updateApproval({ ...request, expectedRevision: reviewed.value.revision })
      : await client.programs.approve(request);
    check(); setReviewed({ key, value }); setApproved(value); setNotice('Compilation succeeded and the operation is approved.');
  });

  const run = () => action(invocation ? 'Retrying invocation…' : 'Running Program…', async (client, check) => {
    if (!canRun) throw new Error('Load or create an approval for this saved Program first.');
    if (invocation && invocation.bindingDigest !== approved!.bindingDigest) throw new Error('The approval changed since this invocation. Choose New execution for the newly approved Program.');
    const parsed = JSON.parse(inputs);
    const prepared = client.programs.prepareInvocation({ ...operation(), inputs: parsed,
      ...(invocation ? { invocationId: invocation.invocationId } : {}) });
    if (invocation && JSON.stringify(prepared.inputs) !== JSON.stringify(invocation.inputs)) throw new Error('These inputs differ from the previous invocation. Choose New execution to use a new ID.');
    const recovery = { ...prepared, bindingDigest: approved!.bindingDigest };
    sessionStorage.setItem(recoveryKey, JSON.stringify(recovery));
    setInvocation(recovery);
    const value = await client.programs.invoke(prepared); check();
    setResult(value); setNotice('Execution completed and its result was stored.'); onSaved();
  });

  return <div className="program-editor-backdrop" onClick={onBackdropClick}>
    <div className="program-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="program-editor-title" ref={dialogRef} tabIndex={-1}>
      <header><div><h2 id="program-editor-title">TypeScript Program</h2><p>{contextGraphId}</p></div>
        <button type="button" onClick={close} disabled={!!busy} aria-label="Close Program editor">×</button></header>
      <div className="program-editor-body">
        <div className="program-editor-code">
          <label>Agent<select value={address} disabled={!!busy || !agents.length} onChange={event => {
            if (source && dirty && !window.confirm('Discard unsaved changes and switch agent?')) return;
            setAddress(event.target.value);
          }}>{!address && <option value="">{agents.length ? 'Select a node agent' : 'No node agent selected'}</option>}{agents.map(agent => <option key={agent.address} value={agent.address}>{agent.name} · {agent.address}</option>)}</select></label>
          <p className="program-editor-help">Uses this agent’s key on the node. Graph access and execution permissions still apply.</p>
          {existing && <button type="button" onClick={() => loadSource()} disabled={!!busy || !address}>Reload stored source</button>}
          <label>Program name<input value={name} disabled={!!busy} onChange={event => setName(event.target.value)} /></label>
          <label>Version<input value={version} disabled={!!busy} onChange={event => { setVersion(event.target.value); invalidate(); }} /></label>
          <Suspense fallback={<p>Loading TypeScript editor…</p>}><Editor value={source} disabled={!!busy || (!!existing && !saved)} onChange={value => { setSource(value); invalidate(); }} /></Suspense>
          <div className="program-editor-actions"><button type="button" onClick={save} disabled={!!busy || !address || !source.trim() || !dirty}>Save new version</button>
            <span>{saved ? (dirty ? 'Unsaved changes' : 'Source saved') : existing ? (busy ? 'Loading stored Program' : 'Source not loaded') : 'Unsaved changes'}</span></div>
          {saved && <p className="program-editor-reference">Saved Program: <code>{saved.program.programIri}</code></p>}
          {error && saveAttempt.current && !saved && <p className="program-editor-reference">Last save attempt: <code>{saveAttempt.current.programIri}</code>. Verify this Program before retrying a failed save.</p>}
        </div>
        <aside className="program-editor-controls">
          <h3>Execution permission</h3>
          <fieldset disabled={!!busy}>
            <label>Operation graph<input value={graphId} onChange={event => setGraphId(event.target.value)} /></label>
            <label>Operation IRI<input value={operationIri} placeholder="urn:example:operation:total" onChange={event => setOperationIri(event.target.value)} /></label>
            <label>Allowed caller addresses<textarea rows={3} value={callers} onChange={event => { setCallers(event.target.value); invalidate(); }} /></label>
            <h4>Approved child Programs</h4>
            <p className="program-editor-help">Each child must already have an approved operation on this node. Call it using its Program IRI.</p>
            {children.map((child, index) => <div className="program-editor-child" key={index}>
              {(['programIri', 'graphId', 'operationIri'] as const).map(field => <label key={field}>{field === 'programIri' ? 'Child Program IRI' : field === 'graphId' ? 'Child graph' : 'Child operation IRI'}
                <input value={child[field]} onChange={event => { setChildren(rows => rows.map((row, i) => i === index ? { ...row, [field]: event.target.value } : row)); invalidate(); }} /></label>)}
              <button type="button" onClick={() => { setChildren(rows => rows.filter((_, i) => i !== index)); invalidate(); }}>Remove child</button>
            </div>)}
            <button type="button" disabled={children.length >= 32} onClick={() => { setChildren(rows => [...rows, { graphId, operationIri: '', programIri: '' }]); invalidate(); }}>Add child Program</button>
            <div className="program-editor-limits">
              <label>Max calls<input type="number" min={1} max={256} value={maxCalls} onChange={e => { setMaxCalls(Number(e.target.value)); invalidate(); }} /></label>
              <label>Concurrency<input type="number" min={1} max={8} value={maxConcurrency} onChange={e => { setMaxConcurrency(Number(e.target.value)); invalidate(); }} /></label>
              <label>Timeout (ms)<input type="number" min={100} max={120000} value={timeoutMs} onChange={e => { setTimeoutMs(Number(e.target.value)); invalidate(); }} /></label>
            </div>
          </fieldset>
          <div className="program-editor-actions"><button type="button" disabled={!!busy || !address || !operationIri.trim()} onClick={inspect}>Check approval</button>
            <button type="button" disabled={!!busy || !address || dirty || reviewed?.key !== key} onClick={approve}>{reviewed?.value ? 'Replace approval' : 'Approve Program'}</button></div>
          {reviewed?.value && <details><summary>Current approval · revision {reviewed.value.revision}</summary><pre>{JSON.stringify(reviewed.value.binding, null, 2)}</pre></details>}
          <h3>Invoke</h3>
          <label>Arguments (JSON array)<textarea rows={4} value={inputs} disabled={!!busy} onChange={event => { setInputs(event.target.value); setResult(null); }} /></label>
          <div className="program-editor-actions"><button type="button" onClick={run} disabled={!!busy || !address || !canRun}>{invocation ? 'Retry same invocation' : 'Run Program'}</button>
            {invocation && <button type="button" disabled={!!busy} onClick={() => { if (!result && !window.confirm('The previous invocation may have executed. Start a separate execution with a new ID?')) return;
              sessionStorage.removeItem(recoveryKey); setInvocation(null); setResult(null); }}>New execution</button>}</div>
          {invocation && <p className="program-editor-reference">Invocation: <code>{invocation.invocationId}</code></p>}
          {result && <section aria-label="Execution result"><pre>{JSON.stringify(result.outputs, null, 2)}</pre>
            <p className="program-editor-reference">Execution: <code>{result.executionIri}</code></p>
            {onExecution && <button type="button" onClick={() => onExecution(result.executionIri, result.executionLayer)}>Open execution</button>}</section>}
        </aside>
      </div>
      <footer>{busy && <p role="status">{busy}</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}</footer>
    </div>
  </div>;
}

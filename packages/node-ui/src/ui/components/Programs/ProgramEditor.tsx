import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { Approval, GraphComputer, PreparedInvocation, ProgramReference, Execution, MemoryLayer, RequestedToolPermissions } from '@origintrail-official/dkg-graph-computer';
import { createUuid } from '@origintrail-official/dkg-graph-computer';
import { programClient, fetchProgramAgents, type ProgramAgent } from './client.js';
import { useModalDismiss } from '../Modals/useModalDismiss.js';
import { JsonText, JsonViewer } from '../common/JsonViewer.js';
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
type Saved = { name: string; program: ProgramReference; source: string; version: string; children: string[]; tools: string[]; permissions: string };
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
  const [toolsText, setToolsText] = useState('');
  const [permissionsText, setPermissionsText] = useState('');
  const [children, setChildren] = useState<Child[]>([]);
  const [maxCalls, setMaxCalls] = useState(64);
  const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [inputs, setInputs] = useState(existing ? '[]' : '[[1, 2, 3]]');
  const [saved, setSaved] = useState<Saved | null>(null);
  const [reviewed, setReviewed] = useState<{ key: string; value: Approval | null } | null>(null);
  const [approved, setApproved] = useState<Approval | null>(null);
  const [availableApprovals, setAvailableApprovals] = useState<Approval[]>([]);
  const [approvalToLoad, setApprovalToLoad] = useState<Approval | null>(null);
  const [discoveryError, setDiscoveryError] = useState('');
  const [invocation, setInvocation] = useState<Recovery | null>(null);
  const [result, setResult] = useState<Execution | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const saveAttempt = useRef<{ fingerprint: string; programIri: string; name: string } | null>(null);
  const key = JSON.stringify([canonicalGraph(graphId), operationIri.trim()]);
  const selection = useRef({ key, operationIri }); selection.current = { key, operationIri };
  const childIris = [...new Set(children.map(child => child.programIri.trim()))].sort();
  const toolIris = [...new Set(toolsText.split(/[\s,]+/).filter(Boolean))].sort();
  const dirty = (!existing && !saved) || (!!saved && (name !== saved.name || source !== saved.source || version !== saved.version || JSON.stringify(childIris) !== JSON.stringify(saved.children) || JSON.stringify(toolIris) !== JSON.stringify(saved.tools) || permissionsText !== saved.permissions));
  const canRun = !!approved?.binding.enabled && !dirty && approved.contextGraphId === canonicalGraph(graphId)
    && approved.operationIri === operationIri.trim() && !!saved && matchesProgram(approved, saved.program)
    && approved.binding.allowedCallerAgentAddresses.some(caller => caller.toLowerCase() === address.toLowerCase());
  const runUnavailable = busy || (!address ? 'Select a node agent to run this Program.'
    : !saved ? 'Load or save the Program first.'
    : dirty ? 'Save your changes, then check or approve the new version before running.'
    : !operationIri.trim() ? (availableApprovals.length > 1 ? 'Select an existing operation to run this Program.' : 'Enter an Operation IRI and check its approval, or create an approval for this Program.')
    : !approved ? 'Check the operation approval. It must be enabled and match this saved Program version.'
    : !canRun ? 'The selected agent is not an allowed caller for this approval.' : '');
  const recoveryKey = `dkg-program-invocation:${location.origin}:${address?.toLowerCase()}:${key}`;

  useEffect(() => {
    generation.current++;
    setCallers(address);
    setSaved(null);
    setSource(existing ? '' : TEMPLATE);
    setName(existing?.label ?? 'Untitled Program');
    setVersion('1.0.0'); setChildren([]); setToolsText(''); setPermissionsText('');
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
      const restored = value && value.graphId === canonicalGraph(graphId) && value.operationIri === operationIri.trim() && typeof value.bindingDigest === 'string' ? value : null;
      setInvocation(restored);
      if (restored) setInputs(JSON.stringify(restored.inputs, null, 2));
    } catch { setInvocation(null); }
  }, [recoveryKey]);
  // Approval discovery is read-only. Never create or widen a grant on opening the editor.
  useEffect(() => {
    let active = true;
    setAvailableApprovals([]); setApprovalToLoad(null); setDiscoveryError('');
    if (!address || !saved || !canonicalGraph(graphId)) return;
    const program = saved.program;
    void programClient(address).then(client => client.programs.listApprovals({ graphId: canonicalGraph(graphId) }))
      .then(values => {
        if (!active) return;
        const matches = values.filter(value => matchesProgram(value, program) && value.binding.typescript);
        setAvailableApprovals(matches);
        const current = selection.current.operationIri.trim();
        const selected = current ? matches.find(value => value.operationIri === current) : matches.length === 1 ? matches[0] : undefined;
        if (selected) { setOperationIri(selected.operationIri); setApprovalToLoad(selected); }
      }).catch(cause => { if (active) setDiscoveryError(`Could not find existing approvals: ${cause instanceof Error ? cause.message : String(cause)}. You can enter an operation and check it manually.`); });
    return () => { active = false; };
  }, [address, saved?.program, graphId]);
  // Runs after the operation's recovery state is reset, so selecting an operation
  // cannot erase the approval that was just loaded for it.
  useEffect(() => {
    if (approvalToLoad && saved && JSON.stringify([approvalToLoad.contextGraphId, approvalToLoad.operationIri]) === key) {
      showApproval(approvalToLoad, saved.program);
    }
  }, [approvalToLoad, key, saved?.program]);
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
    const permissions = value.requestedPermissions ? JSON.stringify(value.requestedPermissions, null, 2) : '';
    setToolsText((value.requiredTools ?? []).join('\n')); setPermissionsText(permissions);
    if (value.requestedPermissions) setGraphId(value.requestedPermissions.graphId);
    setName(loadedName); setSource(value.source); setVersion(value.version);
    setChildren(value.permittedPrograms.map(programIri => ({ graphId, operationIri: '', programIri })));
    setSaved({ tools: [...(value.requiredTools ?? [])].sort(), permissions, name: loadedName, source: value.source, version: value.version, children: [...value.permittedPrograms].sort(),
      program: { graphId: value.contextGraphId, programIri: value.programIri, programLayer: value.layer,
        sourceHash: value.sourceHash, authorAgentAddress: value.authorAgentAddress } });
    invalidate(); setNotice('Source loaded. Saving creates a new Program version.');
    });
  };

  function parsePermissions(): RequestedToolPermissions | undefined {
    if (!permissionsText.trim()) return undefined;
    const value = JSON.parse(permissionsText);
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.graphId !== 'string'
      || Object.keys(value).some(key => !['graphId', 'executionLayer', 'query', 'sparqlRead', 'assetCreation'].includes(key))) {
      throw new Error('Permissions need graphId and only query, sparqlRead, assetCreation or executionLayer fields.');
    }
    return value;
  }

  const save = () => action('Saving new version…', async (client, check) => {
    if (!name.trim()) throw new Error('Give the Program a name.');
    if (!source.trim()) throw new Error('Write a Program first.');
    if (new TextEncoder().encode(source).length > 262144) throw new Error('Source exceeds 256 KiB.');
    if (childIris.some(iri => !iri) || childIris.length !== children.length) throw new Error('Each child needs a distinct Program IRI.');
    const requestedPermissions = parsePermissions();
    if (toolIris.length && !requestedPermissions) throw new Error('Describe the requested tool permissions before saving.');
    const fingerprint = JSON.stringify([name.trim(), source, version, childIris, toolIris, requestedPermissions]);
    if (saveAttempt.current?.fingerprint !== fingerprint) {
      const id = createUuid();
      saveAttempt.current = { fingerprint, programIri: `urn:dkg:program:${id}`, name: `${name.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 100) || 'program'}-${id}` };
    }
    const attempt = saveAttempt.current!;
    const value = await client.programs.upload({ graphId: contextGraphId, source, version, language: 'typescript-v1',
      requiredTools: toolIris, requestedPermissions, permittedPrograms: childIris, programIri: attempt.programIri, name: attempt.name, label: name.trim(),
      derivedFrom: saved?.program.programIri ?? existing?.programIri }); check();
    setSaved({ tools: toolIris, permissions: permissionsText, name, program: value, source, version, children: childIris }); invalidate();
    if (requestedPermissions) setGraphId(requestedPermissions.graphId);
    setNotice('Saved in Working Memory. Execution permission has not changed.');
    onSaved();
  });

  function showApproval(value: Approval | null, program: ProgramReference) {
    setReviewed({ key, value }); setApproved(null);
    if (value?.binding.enabled && matchesProgram(value, program) && value.binding.typescript) {
      setApproved(value);
      setCallers(value.binding.allowedCallerAgentAddresses.join('\n'));
      setChildren(value.binding.typescript.children.map(child => ({ graphId: child.contextGraphId, operationIri: child.operationIri, programIri: child.programIri })));
      setMaxCalls(value.binding.typescript.maxCalls); setMaxConcurrency(value.binding.typescript.maxConcurrency); setTimeoutMs(value.binding.typescript.timeoutMs);
    }
    setNotice(value ? 'Existing approval loaded. Running uses its current permissions.' : 'No approval exists for this operation.');
  }

  const inspect = () => action('Checking approval…', async (client, check) => {
    let value: Approval | null;
    try { value = await client.programs.getApproval(operation()); }
    catch (cause) { if ((cause as { status?: number }).status === 404) value = null; else throw cause; }
    check();
    if (selection.current.key !== key) return;
    if (saved) showApproval(value, saved.program);
  });

  const approve = () => action('Compiling and approving…', async (client, check) => {
    if (!saved || dirty || reviewed?.key !== key) throw new Error('Save the source and check the current approval first.');
    const pins = [];
    for (const child of children) {
      const approval = await client.programs.getApproval({ graphId: child.graphId.trim(), operationIri: child.operationIri.trim() }); check();
      if (!approval.binding.enabled || approval.binding.program.programIri !== child.programIri.trim()) throw new Error('A child operation does not match the declared Program.');
      pins.push({ graphId: child.graphId.trim(), operationIri: child.operationIri.trim(), programIri: child.programIri.trim(), bindingDigest: approval.bindingDigest });
    }
    const permissions = parsePermissions();
    if (permissions && canonicalGraph(permissions.graphId) !== canonicalGraph(graphId)) throw new Error('Operation graph must match the stored requested data graph.');
    const request = { ...permissions, ...operation(), program: saved.program, allowedCallers: callers.split(/[\s,]+/).filter(Boolean),
      typescript: { children: pins, requiredTools: saved.tools, maxCalls, maxConcurrency, timeoutMs } };
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
            {availableApprovals.length > 0 && <label>Existing operation<select value={availableApprovals.some(value => value.operationIri === operationIri) ? operationIri : ''}
              onChange={event => { setOperationIri(event.target.value); setApprovalToLoad(availableApprovals.find(value => value.operationIri === event.target.value) ?? null); }}>
              <option value="">Select an operation</option>{availableApprovals.map(value => <option key={value.operationIri} value={value.operationIri}>{value.operationIri}{value.binding.enabled ? '' : ' (disabled)'}</option>)}
            </select></label>}
            <label>Operation IRI<input value={operationIri} placeholder="urn:example:operation:total" onChange={event => setOperationIri(event.target.value)} /></label>
            {discoveryError && <p className="program-editor-help">{discoveryError}</p>}
            <label>Allowed caller addresses<textarea rows={3} value={callers} onChange={event => { setCallers(event.target.value); invalidate(); }} /></label>
            <h4>Requested tools</h4>
            <p className="program-editor-help">Stored with the Program. These requests become usable only after the graph owner approves this operation.</p>
            <label>Tool IRIs<textarea rows={3} value={toolsText} placeholder="urn:example:tool:read-devices" onChange={event => { setToolsText(event.target.value); invalidate(); }} /></label>
            <label>Requested tool permissions (JSON)<textarea rows={9} value={permissionsText} placeholder={'{ "graphId": "your-data-graph", "assetCreation": { "toolIri": "urn:example:tool:create-asset" } }'}
              onChange={event => { setPermissionsText(event.target.value); invalidate(); }} /></label>
            <p className="program-editor-help">Use query for a fixed catalog query, sparqlRead for bounded reads, or assetCreation for writes. The data graph, memory layer, output contract and read limits are part of the saved request.</p>
            {saved?.tools.length ? <section aria-label="Permissions to approve"><strong>Tools requested by this saved Program</strong>
              <ul>{saved.tools.map(tool => <li key={tool}><code>{tool}</code></li>)}</ul>
              {saved.permissions && <JsonText text={saved.permissions} label="Saved tool permissions" />}
            </section> : null}
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
          {reviewed?.value && <details><summary>Current approval · revision {reviewed.value.revision}</summary><JsonViewer value={reviewed.value.binding} label="Current approval" /></details>}
          <h3>Invoke</h3>
          <label>Arguments (JSON array)<textarea rows={4} value={inputs} disabled={!!busy} onChange={event => { setInputs(event.target.value); setResult(null); }} /></label>
          <p className="program-editor-help">Passed to run(...args). Use [] when the Program takes no arguments or provides defaults.</p>
          {runUnavailable && <p className="program-editor-help" id="program-run-unavailable">{runUnavailable}</p>}
          <div className="program-editor-actions"><button type="button" onClick={run} disabled={!!runUnavailable} aria-describedby={runUnavailable ? 'program-run-unavailable' : undefined}>{invocation ? 'Retry same invocation' : 'Run Program'}</button>
            {invocation && <button type="button" disabled={!!busy} onClick={() => { if (!result && !window.confirm('The previous invocation may have executed. Start a separate execution with a new ID?')) return;
              sessionStorage.removeItem(recoveryKey); setInvocation(null); setResult(null); }}>New execution</button>}</div>
          {invocation && <p className="program-editor-reference">Invocation: <code>{invocation.invocationId}</code></p>}
          {result && <section aria-label="Execution result"><JsonViewer value={result.outputs} label="Program output" />
            <p className="program-editor-reference">Execution: <code>{result.executionIri}</code></p>
            {onExecution && <button type="button" onClick={() => onExecution(result.executionIri, result.executionLayer)}>Open execution</button>}</section>}
        </aside>
      </div>
      <footer>{busy && <p role="status">{busy}</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}</footer>
    </div>
  </div>;
}

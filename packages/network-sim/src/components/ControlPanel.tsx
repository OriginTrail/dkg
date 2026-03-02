import { useState, useCallback, useEffect, useRef } from 'react';
import { useStore } from '../store';
import * as api from '../api';
import { OP_COLORS, type OperationType } from '../types';

type Tab = 'setup' | 'simulate' | 'workspace' | 'publish' | 'query' | 'chat' | 'access' | 'stake' | 'fairswap' | 'conviction';

const MANUAL_TABS: { id: Tab; label: string; op: OperationType }[] = [
  { id: 'setup', label: 'Setup', op: 'connect' },
  { id: 'workspace', label: 'Workspace', op: 'workspace' },
  { id: 'publish', label: 'Publish', op: 'publish' },
  { id: 'query', label: 'Query', op: 'query' },
  { id: 'chat', label: 'Chat', op: 'chat' },
  { id: 'access', label: 'Access', op: 'access' },
  { id: 'stake', label: 'Stake', op: 'stake' },
  { id: 'conviction', label: 'Conviction', op: 'conviction' },
  { id: 'fairswap', label: 'FairSwap', op: 'fairswap' },
];

const SIM_TAB: { id: Tab; label: string; op: OperationType } = { id: 'simulate', label: 'Simulate', op: 'connect' };

export function ControlPanel() {
  const { state, dispatch, addOperation, completeOperation } = useStore();
  const [activeTab, setActiveTab] = useState<Tab>('publish');

  return (
    <div className="control-panel">
      <div className="panel-header">
        <span className="panel-title">Controls</span>
      </div>

      <div className="node-selector">
        <label>Active Node</label>
        <div className="node-pills">
          {state.nodes.map((n) => (
            <button
              key={n.id}
              className={`node-pill ${n.id === state.selectedNode ? 'active' : ''} ${n.online ? 'online' : 'offline'}`}
              onClick={() => dispatch({ type: 'SELECT_NODE', id: n.id })}
            >
              N{n.id}
            </button>
          ))}
        </div>
      </div>

      <div className="tab-bar">
        {MANUAL_TABS.map((t) => (
          <button
            key={t.id}
            className={`tab-btn ${activeTab === t.id ? 'active' : ''}`}
            style={activeTab === t.id ? { borderColor: OP_COLORS[t.op] } : undefined}
            onClick={() => setActiveTab(t.id)}
          >
            <span className="tab-dot" style={{ background: OP_COLORS[t.op] }} />
            {t.label}
          </button>
        ))}
        <div className="tab-bar-divider" />
        <button
          className={`tab-btn tab-btn-sim ${activeTab === SIM_TAB.id ? 'active' : ''}`}
          style={activeTab === SIM_TAB.id ? { borderColor: '#f59e0b' } : undefined}
          onClick={() => setActiveTab(SIM_TAB.id)}
        >
          <span className="tab-dot" style={{ background: '#f59e0b' }} />
          {SIM_TAB.label}
        </button>
      </div>

      <div className="tab-content">
        {activeTab === 'setup' && <SetupTab />}
        {activeTab === 'simulate' && <SimulateTab />}
        {activeTab === 'workspace' && <WorkspaceTab />}
        {activeTab === 'publish' && <PublishTab />}
        {activeTab === 'query' && <QueryTab />}
        {activeTab === 'chat' && <ChatTab />}
        {activeTab === 'access' && <AccessTab />}
        {activeTab === 'stake' && <StakeTab />}
        {activeTab === 'conviction' && <ConvictionTab />}
        {activeTab === 'fairswap' && <FairSwapTab />}
      </div>
    </div>
  );
}

function useParanets() {
  const { state } = useStore();
  const [paranets, setParanets] = useState<string[]>([]);

  useEffect(() => {
    const firstOnline = state.nodes.find((n) => n.online);
    if (!firstOnline) return;
    api.fetchParanets(firstOnline.id).then((r) => {
      setParanets(r.paranets.map((p) => p.id || p.name));
    }).catch(() => {});
  }, [state.nodes]);

  return paranets;
}

function SetupTab() {
  const { state, addOperation, completeOperation } = useStore();
  const [paranetId, setParanetId] = useState('devnet-test');
  const [paranetName, setParanetName] = useState('Devnet Test Paranet');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const paranets = useParanets();

  const doQuickSetup = useCallback(async () => {
    setBusy(true);
    setResult('');
    const lines: string[] = [];

    const firstOnline = state.nodes.find((n) => n.online);
    if (!firstOnline) {
      setResult('Error: No nodes online. Start the devnet first.');
      setBusy(false);
      return;
    }

    const opId = addOperation('connect', firstOnline.id, `quick setup: create & subscribe "${paranetId}"`);

    try {
      try {
        await api.createParanet(firstOnline.id, paranetId, paranetName);
        lines.push(`Created paranet "${paranetId}" on Node ${firstOnline.id}`);
      } catch (e: any) {
        if (e.message?.includes('exists') || e.message?.includes('already')) {
          lines.push(`Paranet "${paranetId}" already exists`);
        } else {
          lines.push(`Create paranet: ${e.message}`);
        }
      }

      for (const node of state.nodes) {
        if (!node.online) {
          lines.push(`Node ${node.id}: offline, skipped`);
          continue;
        }
        try {
          await api.subscribeParanet(node.id, paranetId);
          lines.push(`Node ${node.id}: subscribed`);
        } catch (e: any) {
          lines.push(`Node ${node.id}: ${e.message}`);
        }
      }

      completeOperation(opId, 'success', `${paranetId} ready`);
      setResult(lines.join('\n'));
    } catch (e: any) {
      completeOperation(opId, 'error', e.message);
      setResult(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [paranetId, paranetName, state.nodes, addOperation, completeOperation]);

  const doCreateParanet = useCallback(async () => {
    setBusy(true);
    setResult('');
    const opId = addOperation('connect', state.selectedNode, `create paranet "${paranetId}"`);
    try {
      const res = await api.createParanet(state.selectedNode, paranetId, paranetName);
      completeOperation(opId, 'success', res.uri);
      setResult(`Created: ${res.uri}`);
    } catch (e: any) {
      completeOperation(opId, 'error', e.message);
      setResult(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [paranetId, paranetName, state.selectedNode, addOperation, completeOperation]);

  const doSubscribeAll = useCallback(async () => {
    setBusy(true);
    setResult('');
    const lines: string[] = [];
    for (const node of state.nodes) {
      if (!node.online) {
        lines.push(`Node ${node.id}: offline, skipped`);
        continue;
      }
      try {
        await api.subscribeParanet(node.id, paranetId);
        lines.push(`Node ${node.id}: subscribed to "${paranetId}"`);
      } catch (e: any) {
        lines.push(`Node ${node.id}: ${e.message}`);
      }
    }
    setResult(lines.join('\n'));
    setBusy(false);
  }, [paranetId, state.nodes]);

  return (
    <div className="tab-form">
      <div className="setup-section">
        <div className="setup-section-title">Quick Setup</div>
        <p className="setup-hint">
          Creates a paranet and subscribes all online nodes. Run this once after starting the devnet.
        </p>
        <button className="btn btn-primary btn-wide" disabled={busy} onClick={doQuickSetup}>
          {busy ? 'Setting up...' : 'Initialize Devnet'}
        </button>
      </div>

      <div className="setup-divider" />

      <div className="setup-section">
        <div className="setup-section-title">Paranet Management</div>
        {paranets.length > 0 && (
          <div className="paranet-list">
            <label>Existing Paranets</label>
            {paranets.map((p) => (
              <div key={p} className="paranet-item">{p}</div>
            ))}
          </div>
        )}
        <div className="form-group">
          <label>Paranet ID</label>
          <input value={paranetId} onChange={(e) => setParanetId(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Paranet Name</label>
          <input value={paranetName} onChange={(e) => setParanetName(e.target.value)} />
        </div>
        <div className="btn-row">
          <button className="btn btn-primary" disabled={busy} onClick={doCreateParanet}>
            Create
          </button>
          <button className="btn btn-secondary" disabled={busy} onClick={doSubscribeAll}>
            Subscribe All Nodes
          </button>
        </div>
      </div>

      {result && <pre className="result-box code">{result}</pre>}
    </div>
  );
}

type SimOp = 'publish' | 'workspace' | 'query' | 'chat';

const SIM_OPS: { id: SimOp; label: string }[] = [
  { id: 'publish', label: 'Publish' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'query', label: 'Query' },
  { id: 'chat', label: 'Chat' },
];

interface SimStats {
  total: number;
  completed: number;
  errors: number;
  startedAt: number;
  finishedAt?: number;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rndId(): string {
  return Math.random().toString(36).slice(2, 8);
}

let simCounter = 0;

function SimulateTab() {
  const { state, dispatch, addBroadcast, addOperation, completeOperation } = useStore();
  const [simName, setSimName] = useState(() => `Simulation #${++simCounter}`);
  const [opCount, setOpCount] = useState(500);
  const [opsPerSec, setOpsPerSec] = useState(10);
  const [concurrency, setConcurrency] = useState(10);
  const [kasPerPublish, setKasPerPublish] = useState(1);
  const [paranet, setParanet] = useState('devnet-test');
  const [enabledOps, setEnabledOps] = useState<Set<SimOp>>(new Set(['publish', 'workspace', 'query', 'chat']));
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<SimStats | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const paranets = useParanets();

  const toggleOp = useCallback((op: SimOp) => {
    setEnabledOps((prev) => {
      const next = new Set(prev);
      if (next.has(op)) {
        if (next.size > 1) next.delete(op);
      } else {
        next.add(op);
      }
      return next;
    });
  }, []);

  const runSimulation = useCallback(async () => {
    const ops = Array.from(enabledOps);
    const simId = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    dispatch({
      type: 'START_SIMULATION',
      id: simId,
      name: simName || `Simulation #${simCounter}`,
      config: { opCount, opsPerSec, concurrency, kasPerPublish, paranet, enabledOps: ops },
    });

    const simStats: SimStats = { total: opCount, completed: 0, errors: 0, startedAt: Date.now() };
    setStats({ ...simStats });
    setRunning(true);

    try {
      const res = await fetch('/sim/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: simName, opCount, opsPerSec, concurrency, kasPerPublish, paranet, enabledOps: ops }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }));
        simStats.errors = 1;
        simStats.finishedAt = Date.now();
        setStats({ ...simStats });
        setRunning(false);
        dispatch({ type: 'STOP_SIMULATION' });
        return;
      }
    } catch {
      setRunning(false);
      dispatch({ type: 'STOP_SIMULATION' });
      return;
    }

    const es = new EventSource('/sim/events');
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);

        if (event.type === 'op') {
          if (simStats.finishedAt) return; // ignore late op events after done
          const opType = event.opType as string;
          const nodeId = event.nodeId as number;
          const isBroadcast = opType === 'publish' || opType === 'workspace';
          const opId = isBroadcast
            ? addBroadcast(opType as any, nodeId, `sim ${opType}`)
            : addOperation(opType as any, nodeId, `sim ${opType}`);
          completeOperation(opId, event.success ? 'success' : 'error', event.detail);
          dispatch({ type: 'RECORD_OP', opType, success: event.success, durationMs: event.durationMs, phases: event.phases });
          simStats.completed++;
          if (!event.success) simStats.errors++;
          setStats({ ...simStats });
        }

        if (event.type === 'status') {
          if (simStats.finishedAt) return;
          simStats.completed = event.completed;
          simStats.errors = event.errors;
          setStats({ ...simStats });
        }

        if (event.type === 'done') {
          simStats.completed = event.completed;
          simStats.errors = event.errors;
          simStats.finishedAt = Date.now();
          setStats({ ...simStats });
          es.close();
          eventSourceRef.current = null;
          setRunning(false);
          dispatch({ type: 'STOP_SIMULATION' });
          setSimName(`Simulation #${++simCounter}`);
        }

        if (event.type === 'error') {
          simStats.errors++;
          setStats({ ...simStats });
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      if (running) {
        simStats.finishedAt = Date.now();
        setStats({ ...simStats });
        setRunning(false);
        dispatch({ type: 'STOP_SIMULATION' });
      }
    };
  }, [opCount, opsPerSec, concurrency, paranet, enabledOps, simName, kasPerPublish, addBroadcast, addOperation, completeOperation, dispatch]);

  const stopSimulation = useCallback(async () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    await fetch('/sim/stop', { method: 'POST' }).catch(() => {});
    dispatch({ type: 'STOP_SIMULATION' });
    setRunning(false);
  }, [dispatch]);

  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => forceUpdate((n) => n + 1), 250);
    return () => clearInterval(iv);
  }, [running]);

  const elapsed = stats
    ? ((stats.finishedAt ?? Date.now()) - stats.startedAt) / 1000
    : 0;
  const actualOps = stats ? (stats.completed + stats.errors) : 0; // total finished (success + fail)
  const pct = stats ? Math.min(100, Math.round((actualOps / stats.total) * 100)) : 0;

  return (
    <div className="tab-form">
      <div className="setup-hint">
        Run automated operations across all online nodes. Operations execute server-side (no browser bottleneck) and stream results here for visualization.
      </div>

      <div className="form-group">
        <label>Simulation Name</label>
        <input value={simName} onChange={(e) => setSimName(e.target.value)} disabled={running}
          placeholder="Name this simulation run" />
      </div>

      <div className="form-group">
        <label>Paranet</label>
        {paranets.length > 0 ? (
          <select value={paranet} onChange={(e) => setParanet(e.target.value)} disabled={running}>
            {paranets.map((p) => <option key={p} value={p}>{p}</option>)}
            {!paranets.includes(paranet) && <option value={paranet}>{paranet}</option>}
          </select>
        ) : (
          <input value={paranet} onChange={(e) => setParanet(e.target.value)} disabled={running} />
        )}
      </div>

      <div className="form-group">
        <label>Operations</label>
        <div className="graph-target-pills">
          {SIM_OPS.map(({ id, label }) => (
            <button
              key={id}
              className={`target-pill ${enabledOps.has(id) ? 'active' : ''}`}
              style={enabledOps.has(id) ? { background: OP_COLORS[id] } : undefined}
              onClick={() => toggleOp(id)}
              disabled={running}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="sim-params">
        <div className="form-group">
          <label>Total Ops</label>
          <input type="number" min={1} max={100000} value={opCount}
            onChange={(e) => setOpCount(Math.max(1, parseInt(e.target.value) || 1))} disabled={running} />
        </div>
        <div className="form-group">
          <label>Ops/sec</label>
          <input type="number" min={0.5} max={1000} step={0.5} value={opsPerSec}
            onChange={(e) => setOpsPerSec(Math.max(0.5, parseFloat(e.target.value) || 1))} disabled={running} />
        </div>
        <div className="form-group">
          <label>Concurrency</label>
          <input type="number" min={1} max={200} value={concurrency}
            onChange={(e) => setConcurrency(Math.max(1, parseInt(e.target.value) || 1))} disabled={running} />
        </div>
        <div className="form-group">
          <label>KAs per Publish</label>
          <input type="number" min={1} max={100} value={kasPerPublish}
            onChange={(e) => setKasPerPublish(Math.max(1, parseInt(e.target.value) || 1))} disabled={running} />
        </div>
      </div>

      <button
        className={`btn ${running ? 'btn-danger' : 'btn-primary'} btn-wide`}
        onClick={running ? stopSimulation : runSimulation}
      >
        {running ? 'Stop Simulation' : 'Play Simulation'}
      </button>

      {stats && (
        <div className="sim-stats">
          <div className="sim-progress-bar">
            <div
              className="sim-progress-fill"
              style={{ width: `${pct}%`, background: running ? OP_COLORS.connect : (stats.errors > 0 ? '#f59e0b' : '#10b981') }}
            />
          </div>
          <div className="sim-stats-grid">
            <div className="sim-stat">
              <span className="sim-stat-value">{stats.completed}/{stats.total}</span>
              <span className="sim-stat-label">succeeded</span>
            </div>
            <div className="sim-stat">
              <span className="sim-stat-value" style={{ color: stats.errors > 0 ? '#ef4444' : undefined }}>
                {stats.errors}
              </span>
              <span className="sim-stat-label">errors</span>
            </div>
            <div className="sim-stat">
              <span className="sim-stat-value">{elapsed > 0 ? (actualOps / elapsed).toFixed(1) : '0'}</span>
              <span className="sim-stat-label">ops/sec</span>
            </div>
            <div className="sim-stat">
              <span className="sim-stat-value">{elapsed.toFixed(1)}s</span>
              <span className="sim-stat-label">elapsed</span>
            </div>
          </div>
          {stats.finishedAt && (
            <div className="sim-summary">
              Simulation complete: {stats.completed} succeeded, {stats.errors} failed in {elapsed.toFixed(1)}s
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WorkspaceTab() {
  const { state, addBroadcast, completeOperation } = useStore();
  const paranets = useParanets();
  const [paranet, setParanet] = useState('devnet-test');
  const [subject, setSubject] = useState('did:dkg:entity:ws-001');
  const [predicate, setPredicate] = useState('http://schema.org/name');
  const [object, setObject] = useState('Workspace Draft');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [wsContents, setWsContents] = useState('');

  const fmtObj = (v: string) =>
    v.startsWith('http') || v.startsWith('did:') || v.startsWith('urn:') ? v : `"${v}"`;

  const doWrite = useCallback(async () => {
    setBusy(true);
    setResult('');
    const graph = paranet.startsWith('did:') ? paranet : `did:dkg:paranet:${paranet}`;
    const quads = [{ subject, predicate, object: fmtObj(object), graph }];
    const opId = addBroadcast('workspace', state.selectedNode, 'workspace write');
    try {
      const res = await api.writeToWorkspace(state.selectedNode, paranet, quads);
      completeOperation(opId, 'success', res.workspaceOperationId);
      setResult(`Written to workspace.\nOperation: ${res.workspaceOperationId}`);
    } catch (e: any) {
      completeOperation(opId, 'error', e.message);
      setResult(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [subject, predicate, object, paranet, state.selectedNode, addBroadcast, completeOperation]);

  const doQueryWorkspace = useCallback(async () => {
    setBusy(true);
    setWsContents('');
    const sparql = `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 50`;
    try {
      const res = await api.queryNode(state.selectedNode, sparql, paranet, {
        graphSuffix: '_workspace',
      });
      setWsContents(JSON.stringify(res.result, null, 2));
    } catch (e: any) {
      setWsContents(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [paranet, state.selectedNode]);

  const doEnshrine = useCallback(async () => {
    setBusy(true);
    setResult('');
    const opId = addBroadcast('publish', state.selectedNode, 'enshrine workspace');
    try {
      const res = await api.enshrineFromWorkspace(state.selectedNode, paranet, 'all', true);
      completeOperation(opId, 'success', `KC: ${res.kcId}`);
      setResult(
        `Enshrined to chain.\nKC: ${res.kcId}\nStatus: ${res.status}\nKAs: ${res.kas?.length ?? 0}` +
        (res.txHash ? `\nTx: ${res.txHash}` : ''),
      );
    } catch (e: any) {
      completeOperation(opId, 'error', e.message);
      setResult(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [paranet, state.selectedNode, addBroadcast, completeOperation]);

  return (
    <div className="tab-form">
      <div className="setup-hint">
        Write draft triples to the workspace (free, no gas). When ready, enshrine them to the chain with full finality.
      </div>

      <div className="form-group">
        <label>Paranet</label>
        {paranets.length > 0 ? (
          <select value={paranet} onChange={(e) => setParanet(e.target.value)}>
            {paranets.map((p) => <option key={p} value={p}>{p}</option>)}
            {!paranets.includes(paranet) && <option value={paranet}>{paranet}</option>}
          </select>
        ) : (
          <input value={paranet} onChange={(e) => setParanet(e.target.value)} />
        )}
      </div>

      <div className="setup-section-title">Write to Workspace</div>
      <div className="form-group">
        <label>Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Predicate</label>
        <input value={predicate} onChange={(e) => setPredicate(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Object</label>
        <input value={object} onChange={(e) => setObject(e.target.value)} />
      </div>
      <button className="btn btn-primary btn-wide" disabled={busy} onClick={doWrite}>
        {busy ? 'Writing...' : 'Write to Workspace (Free)'}
      </button>

      <div className="setup-divider" />

      <div className="setup-section-title">Workspace Contents</div>
      <button className="btn btn-secondary btn-wide" disabled={busy} onClick={doQueryWorkspace}>
        Query Workspace
      </button>
      {wsContents && <pre className="result-box code">{wsContents}</pre>}

      <div className="setup-divider" />

      <div className="setup-section-title">Enshrine to Chain</div>
      <p className="setup-hint">
        Publish all workspace content with full on-chain finality (costs TRAC + gas). Clears workspace after.
      </p>
      <button className="btn btn-primary btn-wide" disabled={busy} onClick={doEnshrine}>
        {busy ? 'Enshrining...' : 'Enshrine All to Chain'}
      </button>

      {result && <pre className="result-box code">{result}</pre>}
    </div>
  );
}

function PublishTab() {
  const { state, addBroadcast, completeOperation } = useStore();
  const paranets = useParanets();
  const [subject, setSubject] = useState('did:dkg:entity:001');
  const [predicate, setPredicate] = useState('http://schema.org/name');
  const [object, setObject] = useState('Test Entity');
  const [privateObj, setPrivateObj] = useState('');
  const [paranet, setParanet] = useState('devnet-test');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  const doPublish = useCallback(async () => {
    setBusy(true);
    setResult('');
    const graph = paranet.startsWith('did:') ? paranet : `did:dkg:paranet:${paranet}`;
    const fmtObj = (v: string) =>
      v.startsWith('http') || v.startsWith('did:') || v.startsWith('urn:') ? v : `"${v}"`;
    const quads = [{ subject, predicate, object: fmtObj(object), graph }];
    const privQuads =
      privateObj.trim()
        ? [{ subject, predicate: 'http://schema.org/secret', object: fmtObj(privateObj), graph }]
        : undefined;

    const label = privQuads ? 'publish (private)' : 'publish';
    const opId = addBroadcast('publish', state.selectedNode, label);

    try {
      const res = await api.publishKA(state.selectedNode, paranet, quads, privQuads);
      completeOperation(opId, 'success', `KC: ${res.kcId}`);
      setResult(`KC: ${res.kcId} | Status: ${res.status} | KAs: ${res.kas?.length ?? 0}`);
    } catch (e: any) {
      completeOperation(opId, 'error', e.message);
      setResult(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [subject, predicate, object, privateObj, paranet, state.selectedNode, addBroadcast, completeOperation]);

  return (
    <div className="tab-form">
      <div className="form-group">
        <label>Paranet</label>
        {paranets.length > 0 ? (
          <select value={paranet} onChange={(e) => setParanet(e.target.value)}>
            {paranets.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
            {!paranets.includes(paranet) && (
              <option value={paranet}>{paranet} (custom)</option>
            )}
          </select>
        ) : (
          <input value={paranet} onChange={(e) => setParanet(e.target.value)} />
        )}
      </div>
      <div className="form-group">
        <label>Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Predicate</label>
        <input value={predicate} onChange={(e) => setPredicate(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Object</label>
        <input value={object} onChange={(e) => setObject(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Private Data (optional)</label>
        <input
          value={privateObj}
          onChange={(e) => setPrivateObj(e.target.value)}
          placeholder="Leave empty for public-only"
        />
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={doPublish}>
        {busy ? 'Publishing...' : 'Publish Knowledge Asset'}
      </button>
      {result && <div className="result-box">{result}</div>}
    </div>
  );
}

function QueryTab() {
  const { state, addOperation, completeOperation } = useStore();
  const paranets = useParanets();
  const [sparql, setSparql] = useState('SELECT * WHERE { ?s ?p ?o } LIMIT 10');
  const [paranet, setParanet] = useState('devnet-test');
  const [graphTarget, setGraphTarget] = useState<'published' | 'workspace' | 'both'>('published');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  const doQuery = useCallback(async () => {
    setBusy(true);
    setResult('');
    const targetLabel = graphTarget === 'workspace' ? 'workspace' : graphTarget === 'both' ? 'published+workspace' : 'published';
    const opId = addOperation('query', state.selectedNode, `query (${targetLabel})`);
    try {
      const opts = graphTarget === 'workspace'
        ? { graphSuffix: '_workspace' as const }
        : graphTarget === 'both'
          ? { includeWorkspace: true }
          : undefined;
      const res = await api.queryNode(state.selectedNode, sparql, paranet || undefined, opts);
      const json = JSON.stringify(res.result, null, 2);
      completeOperation(opId, 'success', `${json.length} chars`);
      setResult(json);
    } catch (e: any) {
      completeOperation(opId, 'error', e.message);
      setResult(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [sparql, paranet, graphTarget, state.selectedNode, addOperation, completeOperation]);

  return (
    <div className="tab-form">
      <div className="form-group">
        <label>Paranet</label>
        {paranets.length > 0 ? (
          <select value={paranet} onChange={(e) => setParanet(e.target.value)}>
            {paranets.map((p) => <option key={p} value={p}>{p}</option>)}
            {!paranets.includes(paranet) && <option value={paranet}>{paranet}</option>}
          </select>
        ) : (
          <input value={paranet} onChange={(e) => setParanet(e.target.value)} />
        )}
      </div>
      <div className="form-group">
        <label>Query Target</label>
        <div className="graph-target-pills">
          {([
            ['published', 'Published'],
            ['workspace', 'Workspace'],
            ['both', 'Both'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              className={`target-pill ${graphTarget === value ? 'active' : ''}`}
              onClick={() => setGraphTarget(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="form-group">
        <label>SPARQL</label>
        <textarea
          rows={4}
          value={sparql}
          onChange={(e) => setSparql(e.target.value)}
          spellCheck={false}
        />
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={doQuery}>
        {busy ? 'Querying...' : 'Execute Query'}
      </button>
      {result && <pre className="result-box code">{result}</pre>}
    </div>
  );
}

function ChatTab() {
  const { state, addOperation, completeOperation } = useStore();
  const [targetNode, setTargetNode] = useState(2);
  const [text, setText] = useState('Hello from the simulator!');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  const doChat = useCallback(async () => {
    const target = state.nodes.find((n) => n.id === targetNode);
    if (!target?.status?.peerId) {
      setResult('Error: Target node not online or peerId unknown');
      return;
    }
    setBusy(true);
    setResult('');
    const opId = addOperation('chat', state.selectedNode, `"${text.slice(0, 30)}"`, targetNode);
    try {
      const res = await api.sendChat(state.selectedNode, target.status.peerId, text);
      if (res.delivered) {
        completeOperation(opId, 'success', 'delivered');
        setResult('Message delivered');
      } else {
        completeOperation(opId, 'error', res.error || 'not delivered');
        setResult(`Not delivered: ${res.error || 'unknown'}`);
      }
    } catch (e: any) {
      completeOperation(opId, 'error', e.message);
      setResult(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [targetNode, text, state.selectedNode, state.nodes, addOperation, completeOperation]);

  return (
    <div className="tab-form">
      <div className="form-group">
        <label>To Node</label>
        <div className="node-pills">
          {state.nodes
            .filter((n) => n.id !== state.selectedNode)
            .map((n) => (
              <button
                key={n.id}
                className={`node-pill ${n.id === targetNode ? 'active' : ''} ${n.online ? 'online' : 'offline'}`}
                onClick={() => setTargetNode(n.id)}
              >
                N{n.id}
              </button>
            ))}
        </div>
      </div>
      <div className="form-group">
        <label>Message</label>
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={doChat}>
        {busy ? 'Sending...' : 'Send Message'}
      </button>
      {result && <div className="result-box">{result}</div>}
    </div>
  );
}

function AccessTab() {
  const { state, addOperation, completeOperation } = useStore();
  const [publisherNode, setPublisherNode] = useState(1);
  const [ual, setUal] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  const doAccess = useCallback(async () => {
    const publisher = state.nodes.find((n) => n.id === publisherNode);
    if (!publisher?.status?.peerId) {
      setResult('Error: Publisher node not online');
      return;
    }
    setBusy(true);
    setResult('');
    const opId = addOperation('access', state.selectedNode, `request KA access`, publisherNode);
    try {
      const res = await api.queryRemote(state.selectedNode, publisher.status.peerId, {
        lookupType: 'ual',
        ual,
      });
      completeOperation(opId, 'success', `status: ${res.status}`);
      setResult(JSON.stringify(res, null, 2));
    } catch (e: any) {
      completeOperation(opId, 'error', e.message);
      setResult(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [publisherNode, ual, state.selectedNode, state.nodes, addOperation, completeOperation]);

  return (
    <div className="tab-form">
      <div className="form-group">
        <label>Publisher Node</label>
        <div className="node-pills">
          {state.nodes
            .filter((n) => n.id !== state.selectedNode)
            .map((n) => (
              <button
                key={n.id}
                className={`node-pill ${n.id === publisherNode ? 'active' : ''} ${n.online ? 'online' : 'offline'}`}
                onClick={() => setPublisherNode(n.id)}
              >
                N{n.id}
              </button>
            ))}
        </div>
      </div>
      <div className="form-group">
        <label>Knowledge Asset UAL</label>
        <input
          value={ual}
          onChange={(e) => setUal(e.target.value)}
          placeholder="did:dkg:..."
        />
      </div>
      <button className="btn btn-primary" disabled={busy || !ual} onClick={doAccess}>
        {busy ? 'Requesting...' : 'Request Private Access'}
      </button>
      {result && <pre className="result-box code">{result}</pre>}
    </div>
  );
}

function StakeTab() {
  const { state, addOperation, completeOperation } = useStore();
  const [amount, setAmount] = useState('1000');
  const [lockEpochs, setLockEpochs] = useState('12');
  const [result, setResult] = useState('');

  const calcMultiplier = useCallback(() => {
    const n = parseInt(lockEpochs) || 0;
    if (n <= 1) return '1.000';
    const K = 2;
    const H = 365;
    const m = 1 + (K * (n - 1)) / (7 * (n - 1) + H);
    return Math.min(3.0, m).toFixed(3);
  }, [lockEpochs]);

  const doStake = useCallback(async () => {
    const opId = addOperation('stake', state.selectedNode, `stake ${amount} TRAC (${lockEpochs} epochs)`);
    try {
      setResult(
        `Staking ${amount} TRAC with ${lockEpochs} epoch lock...\n` +
        `Conviction multiplier: ${calcMultiplier()}x\n` +
        `Effective weight: ${(parseFloat(amount) * parseFloat(calcMultiplier())).toFixed(2)} TRAC\n\n` +
        `Note: Chain operations require the devnet Hardhat chain to be running.\n` +
        `Use the node's wallet endpoint to check balances.`,
      );
      completeOperation(opId, 'success', `${amount} TRAC × ${calcMultiplier()}`);
    } catch (e: any) {
      completeOperation(opId, 'error', e.message);
      setResult(`Error: ${e.message}`);
    }
  }, [amount, lockEpochs, state.selectedNode, addOperation, completeOperation, calcMultiplier]);

  return (
    <div className="tab-form">
      <div className="form-group">
        <label>Amount (TRAC)</label>
        <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Lock Epochs</label>
        <input type="number" value={lockEpochs} onChange={(e) => setLockEpochs(e.target.value)} />
      </div>
      <div className="conviction-preview">
        <div className="metric">
          <span className="metric-label">Conviction Multiplier</span>
          <span className="metric-value" style={{ color: OP_COLORS.stake }}>
            {calcMultiplier()}x
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Effective Weight</span>
          <span className="metric-value">
            {(parseFloat(amount || '0') * parseFloat(calcMultiplier())).toFixed(2)} TRAC
          </span>
        </div>
      </div>
      <button className="btn btn-primary" onClick={doStake}>
        Stake with Conviction Lock
      </button>
      {result && <pre className="result-box code">{result}</pre>}
    </div>
  );
}

function ConvictionTab() {
  const { state, addOperation, completeOperation } = useStore();
  const [deposit, setDeposit] = useState('5000');
  const [lockEpochs, setLockEpochs] = useState('52');
  const [baseCost, setBaseCost] = useState('100');
  const [result, setResult] = useState('');

  const calcDiscount = useCallback(() => {
    const n = parseInt(lockEpochs) || 0;
    const depositVal = parseFloat(deposit) || 0;
    if (n <= 0 || depositVal <= 0) return 0;
    const C_HALF = 10000;
    const MAX_DISCOUNT = 5000;
    const discount = Math.floor((MAX_DISCOUNT * depositVal * n) / (depositVal * n + C_HALF));
    return discount;
  }, [lockEpochs, deposit]);

  const discountedCost = useCallback(() => {
    const base = parseFloat(baseCost) || 0;
    const discountBps = calcDiscount();
    return (base * (10000 - discountBps)) / 10000;
  }, [baseCost, calcDiscount]);

  const doCreate = useCallback(async () => {
    const opId = addOperation('conviction', state.selectedNode, `create conviction account`);
    try {
      const disc = calcDiscount();
      setResult(
        `Creating Conviction Account...\n` +
        `Deposit: ${deposit} TRAC\n` +
        `Lock: ${lockEpochs} epochs\n` +
        `Discount: ${(disc / 100).toFixed(2)}%\n` +
        `Publishing cost of ${baseCost} TRAC → ${discountedCost().toFixed(2)} TRAC\n\n` +
        `Note: Chain operations require the devnet Hardhat chain to be running.`,
      );
      completeOperation(opId, 'success', `${(disc / 100).toFixed(1)}% discount`);
    } catch (e: any) {
      completeOperation(opId, 'error', e.message);
      setResult(`Error: ${e.message}`);
    }
  }, [deposit, lockEpochs, baseCost, state.selectedNode, addOperation, completeOperation, calcDiscount, discountedCost]);

  return (
    <div className="tab-form">
      <div className="form-group">
        <label>Deposit (TRAC)</label>
        <input type="number" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Lock Epochs</label>
        <input type="number" value={lockEpochs} onChange={(e) => setLockEpochs(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Base Publish Cost (TRAC)</label>
        <input type="number" value={baseCost} onChange={(e) => setBaseCost(e.target.value)} />
      </div>
      <div className="conviction-preview">
        <div className="metric">
          <span className="metric-label">Discount</span>
          <span className="metric-value" style={{ color: OP_COLORS.conviction }}>
            {(calcDiscount() / 100).toFixed(2)}%
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Discounted Cost</span>
          <span className="metric-value">
            {discountedCost().toFixed(2)} TRAC
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Savings</span>
          <span className="metric-value" style={{ color: '#10b981' }}>
            {(parseFloat(baseCost || '0') - discountedCost()).toFixed(2)} TRAC
          </span>
        </div>
      </div>
      <button className="btn btn-primary" onClick={doCreate}>
        Create Conviction Account
      </button>
      {result && <pre className="result-box code">{result}</pre>}
    </div>
  );
}

function FairSwapTab() {
  const { state, addOperation, completeOperation } = useStore();
  const [sellerNode, setSellerNode] = useState(1);
  const [kaId, setKaId] = useState('1');
  const [price, setPrice] = useState('50');
  const [result, setResult] = useState('');

  const doInitiate = useCallback(async () => {
    const opId = addOperation('fairswap', state.selectedNode, `initiate purchase KA #${kaId}`, sellerNode);
    try {
      setResult(
        `FairSwap Purchase Flow:\n\n` +
        `1. Buyer (Node ${state.selectedNode}) initiates purchase of KA #${kaId}\n` +
        `   Price: ${price} TRAC → escrow\n` +
        `   Protocol fee: ${(parseFloat(price) * 0.025).toFixed(2)} TRAC (2.5%)\n\n` +
        `2. Seller (Node ${sellerNode}) fulfills with encrypted data\n` +
        `   → encryptedDataRoot submitted on-chain\n\n` +
        `3. Seller reveals decryption key\n` +
        `   → key submitted on-chain\n\n` +
        `4. Buyer verifies data\n` +
        `   → If valid: seller claims payment\n` +
        `   → If invalid: buyer disputes with merkle proof\n\n` +
        `Note: Chain operations require the devnet Hardhat chain to be running.`,
      );
      completeOperation(opId, 'success', `${price} TRAC escrowed`);
    } catch (e: any) {
      completeOperation(opId, 'error', e.message);
      setResult(`Error: ${e.message}`);
    }
  }, [sellerNode, kaId, price, state.selectedNode, addOperation, completeOperation]);

  return (
    <div className="tab-form">
      <div className="form-group">
        <label>Seller Node</label>
        <div className="node-pills">
          {state.nodes
            .filter((n) => n.id !== state.selectedNode)
            .map((n) => (
              <button
                key={n.id}
                className={`node-pill ${n.id === sellerNode ? 'active' : ''} ${n.online ? 'online' : 'offline'}`}
                onClick={() => setSellerNode(n.id)}
              >
                N{n.id}
              </button>
            ))}
        </div>
      </div>
      <div className="form-group">
        <label>Knowledge Asset ID</label>
        <input value={kaId} onChange={(e) => setKaId(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Price (TRAC)</label>
        <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
      </div>
      <div className="conviction-preview">
        <div className="metric">
          <span className="metric-label">Escrow Amount</span>
          <span className="metric-value" style={{ color: OP_COLORS.fairswap }}>
            {price} TRAC
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Protocol Fee (2.5%)</span>
          <span className="metric-value">
            {(parseFloat(price || '0') * 0.025).toFixed(2)} TRAC
          </span>
        </div>
      </div>
      <button className="btn btn-primary" onClick={doInitiate}>
        Initiate Purchase
      </button>
      {result && <pre className="result-box code">{result}</pre>}
    </div>
  );
}

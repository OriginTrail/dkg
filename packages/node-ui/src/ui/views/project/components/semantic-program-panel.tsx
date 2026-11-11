import { randomUUID } from '../../../lib/randomUUID.js';
import React, { useEffect, useState } from 'react';
import { forkSemanticProgram, invokeSemanticProgram, resolveSemanticProgram, type SemanticMemoryLayer, type SemanticProgramResolution } from '../../../api.js';

// ─── KA Detail View (split-pane: content+triples+graph | provenance) ─────

export const SR_PROGRAM = 'https://origintrail.io/semantic-runtime/v1#Program';

export function SemanticProgramPanel({
  contextGraphId,
  programIri,
  programLayer,
  onRefresh,
  onNavigate,
}: {
  contextGraphId: string;
  programIri: string;
  programLayer: SemanticMemoryLayer;
  onRefresh: () => void;
  onNavigate: (
    uri: string,
    originScrollKey?: string,
    layerContext?: SemanticMemoryLayer,
  ) => void;
}) {
  const [resolution, setResolution] = useState<SemanticProgramResolution | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [forking, setForking] = useState(false);
  const [showFork, setShowFork] = useState(false);
  const [forkIri, setForkIri] = useState('');
  const [executionLayer, setExecutionLayer] = useState<SemanticMemoryLayer | ''>('');
  const [forkLayer, setForkLayer] = useState<SemanticMemoryLayer | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [invocationId, setInvocationId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    resolveSemanticProgram(contextGraphId, programIri, programLayer)
      .then((value) => { if (!cancelled) setResolution(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contextGraphId, programIri, programLayer]);

  const run = async () => {
    if (!executionLayer) {
      setError('Choose where to store the Execution');
      return;
    }
    const id = invocationId ?? randomUUID();
    setInvocationId(id); // Retain on failure: retrying must use the same idempotency key.
    setRunning(true);
    setError(null);
    try {
      const result = await invokeSemanticProgram(
        contextGraphId,
        programIri,
        id,
        programLayer,
        executionLayer,
      );
      if (
        !result.persisted
        || !result.executionIri
        || result.executionLayer !== executionLayer
        || (executionLayer === 'vm' && !result.executionUal)
      ) {
        throw new Error('The daemon did not confirm Execution persistence');
      }
      await Promise.resolve(onRefresh());
      onNavigate(result.executionIri, undefined, executionLayer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  const beginFork = () => {
    setForkIri(`urn:sr:program:${randomUUID()}`);
    setForkLayer('');
    setShowFork(true);
    setError(null);
  };

  const forkProgram = async () => {
    const newProgramIri = forkIri.trim();
    if (!newProgramIri || !forkLayer) {
      setError('New Program IRI and storage layer are required');
      return;
    }
    setForking(true);
    setError(null);
    try {
      const result = await forkSemanticProgram(
        contextGraphId,
        programIri,
        newProgramIri,
        programLayer,
        forkLayer,
      );
      if (
        !result.persisted
        || !result.programIri
        || result.programLayer !== forkLayer
        || (forkLayer === 'vm' && !result.programUal)
      ) {
        throw new Error('The daemon did not confirm forked Program persistence');
      }
      await Promise.resolve(onRefresh());
      onNavigate(result.programIri, undefined, forkLayer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setForking(false);
    }
  };

  return (
    <div className="v10-ka-section" data-testid="semantic-program-panel">
      <div className="v10-ka-section-title">Semantic Program</div>
      {loading && <div className="v10-ka-desc">Resolving operator tools and policy…</div>}
      {resolution && (
        <>
          <div className="v10-ka-prop">
            <span className="v10-ka-prop-key">Executing Node</span>
            <span className="v10-ka-prop-val mono">{resolution.executingNode}</span>
          </div>
          <div className="v10-ka-prop">
            <span className="v10-ka-prop-key">Operator Policy</span>
            <span className="v10-ka-prop-val mono">{resolution.selectedPolicy.iri} · v{resolution.selectedPolicy.version}</span>
          </div>
          <div className="v10-ka-section-title" style={{ marginTop: 12 }}>Required Tools</div>
          {resolution.requiredTools.map((tool) => (
            <div key={tool.toolIri} className="v10-ka-prop" data-testid="semantic-tool-resolution">
              <span className="v10-ka-prop-key">{tool.effective ? '✓ Available' : '✕ Unavailable'}</span>
              <span className="v10-ka-prop-val">
                <span className="mono">{tool.toolIri}</span><br />
                requested · {tool.offered ? 'offered' : 'not offered'} · {tool.policyAllowed ? 'policy allowed' : 'policy denied'} · {tool.locallyInstalled ? 'installed' : 'not installed'} · {tool.locallyEnabled ? 'enabled' : 'disabled'}
                {tool.unavailableReason && <><br />{tool.unavailableReason}</>}
              </span>
            </div>
          ))}
          {resolution.previousExecutions.length > 0 && (
            <>
              <div className="v10-ka-section-title" style={{ marginTop: 12 }}>Previous Executions</div>
              {resolution.previousExecutions.map((execution) => (
                <button key={execution} className="v10-ka-conn" onClick={() => onNavigate(execution)}>
                  <span className="v10-ka-conn-target mono">{execution}</span>
                </button>
              ))}
            </>
          )}
          <label className="v10-form-label" htmlFor="semantic-execution-layer" style={{ marginTop: 12 }}>
            Store Execution in
          </label>
          <select
            id="semantic-execution-layer"
            className="v10-form-input"
            data-testid="semantic-execution-layer"
            value={executionLayer}
            disabled={running}
            onChange={(event) => {
              setExecutionLayer(event.target.value as SemanticMemoryLayer | '');
              setInvocationId(null);
            }}
          >
            <option value="">Choose a layer…</option>
            <option value="wm">Working Memory — local</option>
            <option value="swm">Shared Working Memory — Context Graph members</option>
            <option value="vm">Verifiable Memory — published</option>
          </select>
          <button
            className="v10-ka-back"
            data-testid="run-semantic-program"
            disabled={!resolution.executable || !executionLayer || running}
            onClick={run}
            style={{ marginTop: 12 }}
          >
            {running ? 'Running and storing…' : 'Run Program'}
          </button>
          {!showFork && (
            <button
              className="v10-ka-back"
              data-testid="fork-semantic-program"
              disabled={running || forking}
              onClick={beginFork}
              style={{ marginTop: 8 }}
            >
              Fork Program
            </button>
          )}
          {showFork && (
            <div data-testid="semantic-program-fork-form" style={{ marginTop: 12 }}>
              <label className="v10-form-label" htmlFor="semantic-program-fork-iri">New Program IRI</label>
              <input
                id="semantic-program-fork-iri"
                className="v10-form-input mono"
                data-testid="semantic-program-fork-iri"
                value={forkIri}
                disabled={forking}
                onChange={(event) => setForkIri(event.target.value)}
              />
              <label className="v10-form-label" htmlFor="semantic-program-fork-layer" style={{ marginTop: 8 }}>
                Store copied Program in
              </label>
              <select
                id="semantic-program-fork-layer"
                className="v10-form-input"
                data-testid="semantic-program-fork-layer"
                value={forkLayer}
                disabled={forking}
                onChange={(event) => setForkLayer(event.target.value as SemanticMemoryLayer | '')}
              >
                <option value="">Choose a layer…</option>
                <option value="wm">Working Memory — local</option>
                <option value="swm">Shared Working Memory — Context Graph members</option>
                <option value="vm">Verifiable Memory — published</option>
              </select>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  className="v10-ka-back"
                  data-testid="confirm-fork-semantic-program"
                  disabled={forking || !forkIri.trim() || !forkLayer}
                  onClick={forkProgram}
                >
                  {forking ? 'Storing copy…' : 'Create Copy'}
                </button>
                <button
                  className="v10-ka-back"
                  disabled={forking}
                  onClick={() => setShowFork(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && <div className="v10-ka-desc" data-testid="semantic-program-error">{error}</div>}
    </div>
  );
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Database, Pause, Play, RefreshCw } from 'lucide-react';
import {
  actOnJpbMonitorJob, createJpbMonitorJob, describeJpbMonitorError,
  fetchJpbMonitorJobs, fetchJpbMonitorStatus, monitorErrorCode, parseJpbMonitorConfig,
  updateJpbMonitorJob, type JpbMonitorJob, type JpbMonitorStatus,
} from '../jpb-monitor-api.js';
import { HttpError } from '../http.js';
import { useVisibilityPolling } from '../hooks/useVisibilityPolling.js';
import { useTabsStore } from '../stores/tabs.js';

function timeLabel(time: string | number | undefined): string {
  if (time === undefined || time === null) return '—';
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
}

export function SourcesPage() {
  const [status, setStatus] = useState<JpbMonitorStatus | null>(null);
  const [jobs, setJobs] = useState<JpbMonitorJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<JpbMonitorJob | null>(null);
  const [orders, setOrders] = useState('');
  const [minutes, setMinutes] = useState('30');
  const [batchSize, setBatchSize] = useState('10');
  const mounted = useRef(true);
  const readSequence = useRef(0);
  const reading = useRef<number | null>(null);
  const mutating = useRef(false);
  const openTab = useTabsStore((s) => s.openTab);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; readSequence.current++; reading.current = null; };
  }, []);

  const refresh = useCallback(async () => {
    if (reading.current !== null || mutating.current) return;
    const sequence = ++readSequence.current;
    reading.current = sequence;
    try {
      const metadata = await fetchJpbMonitorStatus();
      const response = metadata.enabled ? await fetchJpbMonitorJobs() : { jobs: [] };
      if (!mounted.current || sequence !== readSequence.current) return;
      setStatus(metadata);
      setJobs(response.jobs);
      setReadError(null);
    } catch (error) {
      if (!mounted.current || sequence !== readSequence.current) return;
      setReadError(describeJpbMonitorError(error));
      if (error instanceof HttpError && [401, 403, 404].includes(error.status)) {
        setStatus(null);
        setJobs([]);
      }
    } finally {
      if (reading.current === sequence) reading.current = null;
      if (mounted.current && sequence === readSequence.current) setLoading(false);
    }
  }, []);
  useVisibilityPolling(() => { void refresh(); }, 15_000);

  const resetForm = () => { setEditing(null); setOrders(''); setMinutes('30'); setBatchSize('10'); };
  const edit = (job: JpbMonitorJob) => {
    setEditing(job);
    setOrders(job.orderNos.join('\n'));
    setMinutes(String(job.intervalMs / 60_000));
    setBatchSize(String(job.batchSize));
    setActionError(null);
    setNotice(null);
  };

  const mutate = async (operation: () => Promise<{ job: JpbMonitorJob }>, message: string, clearForm = false) => {
    if (mutating.current) return;
    mutating.current = true;
    readSequence.current++; // An older poll must not overwrite the mutation response.
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const { job } = await operation();
      if (!mounted.current) return;
      setJobs((previous) => previous.some((item) => item.id === job.id)
        ? previous.map((item) => item.id === job.id ? job : item) : [...previous, job]);
      setNotice(message);
      if (clearForm) resetForm();
    } catch (error) {
      if (mounted.current) setActionError(describeJpbMonitorError(error));
    } finally {
      mutating.current = false;
      if (mounted.current) { setBusy(false); setLoading(false); }
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!status?.enabled || busy) return;
    try {
      const config = parseJpbMonitorConfig(orders, minutes, batchSize, status);
      void mutate(() => editing
        ? updateJpbMonitorJob(editing.id, { orderNos: config.orderNos, intervalMs: config.intervalMs }, editing.revision)
        : createJpbMonitorJob(config), editing ? 'Monitoring job updated.' : 'Monitoring job created.', true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Check the job settings.');
    }
  };

  return (
    <div className="page-section jpb-sources">
      <div className="jpb-sources-heading">
        <div><h1 className="page-title">Sources</h1><p>Choose which JPB orders this node monitors.</p></div>
        <button type="button" className="dkg-btn dkg-btn-secondary" onClick={() => { void refresh(); }} disabled={busy}>
          <RefreshCw size={14} /> Refresh list
        </button>
      </div>
      <section className="card">
        <div className="card-header"><h2 className="card-title"><Database size={14} /> JPB SQL monitoring</h2>
          {status?.enabled && <span className="badge">{status.mode === 'working-memory-only' ? 'Working Memory only' : status.mode}</span>}
        </div>
        <div className="card-body jpb-sources-explanation">
          <p>One reusable Graph Computer fetch Program accepts the whole selected order list. After verifying its private request, the SQL worker fetches the orders in batches and stores their data in DKG Working Memory.</p>
          <p>Request acceptance starts ingestion. Fetch completion means every batch and its completion receipt have been verified. Analysis of stored snapshots is a separate operation; legacy jobs retain their analysis Programs.</p>
          <p>Each job checks for changes on its own schedule. Pause stops future checks; it keeps the data already ingested.</p>
          <p>Orders are fetched in separate batches. They are not captured in one SQL transaction.</p>
          {status?.enabled && <p>Access: configured JPB owner or node operator. {status.mode === 'working-memory-only' && 'These snapshots are not published on chain.'}</p>}
        </div>
      </section>
      <div aria-live="polite" className="jpb-sources-messages">
        {loading && <p>Loading monitoring configuration…</p>}
        {readError && <p role="alert" className="jpb-sources-error">{readError}</p>}
        {actionError && <p role="alert" className="jpb-sources-error">{actionError}</p>}
        {notice && <p className="jpb-sources-success">{notice}</p>}
        {status && !status.enabled && <p>JPB monitoring is disabled on this node. A node operator can configure the source worker.</p>}
      </div>
      {status?.enabled && <>
        <section className="card">
          <div className="card-header"><h2 className="card-title">{editing ? 'Edit monitoring job' : 'Create monitoring job'}</h2>
            {editing && <span className="mono">revision {editing.revision}</span>}
          </div>
          <form className="card-body jpb-sources-form" onSubmit={submit}>
            <label className="jpb-sources-orders">Order numbers (NAF)
              <textarea aria-label="Order numbers (NAF)" rows={3} value={orders} onChange={(e) => setOrders(e.target.value)} disabled={busy} placeholder="46975, 46976" required />
              <span className="jpb-sources-hint">Separate by commas or new lines. At most {Math.min(1000, status.maxOrders)} unique orders.</span>
            </label>
            <label>Check every (minutes)<input aria-label="Check every (minutes)" type="number" min={Math.ceil(Math.max(1_800_000, status.minIntervalMs) / 60_000)} step="1" value={minutes} onChange={(e) => setMinutes(e.target.value)} disabled={busy} required /></label>
            <label>Orders per batch<input aria-label="Orders per batch" type="number" min="1" max={Math.min(10, status.maxBatchSize)} step="1" value={batchSize} onChange={(e) => setBatchSize(e.target.value)} disabled={busy || Boolean(editing)} required />
              <span className="jpb-sources-hint">{editing ? 'Batch size stays fixed for this job.' : 'Each batch produces a separate DKG snapshot.'}</span>
            </label>
            <div className="jpb-sources-controls">
              <button className="dkg-btn" type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create job'}</button>
              {editing && <button className="dkg-btn dkg-btn-secondary" type="button" onClick={resetForm} disabled={busy}>Cancel edit</button>}
            </div>
          </form>
        </section>
        <div className="jpb-sources-jobs">
          {!loading && jobs.length === 0 && <p>No monitoring jobs yet. Create a job to select orders and a schedule.</p>}
          {jobs.map((job) => <section className="card" key={job.id} aria-label={`Monitoring job ${job.id}`}>
            <div className="card-header jpb-sources-job-header">
              <div><h2 className="card-title">{job.orderNos.length} order{job.orderNos.length === 1 ? '' : 's'} · {job.intervalMs / 60_000} min after each check</h2>
                <span className="jpb-sources-hint mono">{job.id} · revision {job.revision}</span>
                <div className="jpb-sources-hint">{job.programsMode === 'data-only' ? 'One fetch Program' : 'Legacy analysis job'}</div>
              </div>
              <span className="badge">{job.running ? `${job.status} · checking` : job.status}{job.freshness && ` · ${job.freshness === 'never' ? 'no complete fetch yet' : job.freshness}`}</span>
            </div>
            <div className="card-body">
              <div className="jpb-sources-order-list mono">NAF: {job.orderNos.slice(0, 20).join(', ')}{job.orderNos.length > 20 && ' …'}</div>
              {job.orderNos.length > 20 && <details className="jpb-sources-order-list">
                <summary>Show all {job.orderNos.length} order numbers</summary>
                <div className="mono">{job.orderNos.join(', ')}</div>
              </details>}
              {job.contextGraphId && <section aria-label="JPB data graph">
                <p>All monitored orders share the private jpb-data graph. SQL batches are internal checkpoints.</p>
                <button type="button" className="jpb-sources-graph-link" onClick={() => openTab({ id: `project:${job.contextGraphId}`, label: 'JPB data', closable: true })}>Open JPB data</button>
              </section>}
              <p className="jpb-sources-hint">Checked batches: {job.batches.filter((batch) => ['success', 'unchanged'].includes(batch.status)).length} / {job.batches.length}</p>
              {job.coverage?.returnedOrders !== undefined && <section aria-label="SQL coverage">
                <p>SQL returned {job.coverage.returnedOrders} / {job.coverage.selectedOrders} monitored orders in the last completed check.</p>
                {job.coverage.notReturnedOrders > 0 && <>
                  <p>{job.coverage.notReturnedOrders} orders were not returned by the configured SQL query. Their last-known data keeps its earlier fetch time. This does not prove deletion or completion.</p>
                  <details><summary>Show orders not returned</summary><div className="mono">{job.coverage.notReturnedOrderNos.join(', ')}</div></details>
                </>}
              </section>}
              {job.programsMode === 'data-only' && <section aria-label="Fetch Program">
                <p>{job.fetch?.status === 'completed' ? job.coverage?.notReturnedOrders ? 'Fetch completed with coverage gaps' : 'Fetch completed' : job.fetch?.status === 'accepted' ? 'Request accepted · ingestion pending' : 'Fetch request not accepted yet'}
                  {job.fetchProgramKaCount !== undefined && ` · ${job.fetchProgramKaCount} fetch Program source KA${job.fetchProgramKaCount === 1 ? '' : 's'}`}</p>
                {job.fetch && <>
                  <dl className="jpb-sources-times">
                    <div><dt>Request ID</dt><dd className="mono" style={{ wordBreak: 'break-all' }}>{job.fetch.requestId}</dd></div>
                    <div><dt>Native execution</dt><dd className="mono" style={{ wordBreak: 'break-all' }}>{job.fetch.executionIri}</dd></div>
                  </dl>
                  <button type="button" className="jpb-sources-graph-link" onClick={() => openTab({ id: `project:${job.fetch!.contextGraphId}`, label: 'JPB fetch control', closable: true })}>Open fetch control graph</button>
                </>}
              </section>}
              <dl className="jpb-sources-times">
                <div><dt>Last attempt</dt><dd>{timeLabel(job.lastAttemptAt)}</dd></div>
                <div><dt>Source fetched</dt><dd>{timeLabel(job.lastFetchAt)}</dd></div>
                <div><dt>Last complete SQL cohort</dt><dd>{timeLabel(job.lastSuccessAt)}</dd></div>
                <div><dt>Last completed check</dt><dd>{timeLabel(job.lastCompletedAt ?? job.lastSuccessAt)}</dd></div>
                <div><dt>Next check</dt><dd>{job.status === 'paused' ? 'Paused' : timeLabel(job.nextDueAt)}</dd></div>
              </dl>
              {job.lastError && <p className="jpb-sources-error">Last check failed: {monitorErrorCode(job.lastError) ?? 'MONITORING_ERROR'}</p>}
              <div className="jpb-sources-controls">
                <button type="button" className="dkg-btn dkg-btn-secondary" onClick={() => edit(job)} disabled={busy || job.running}>Edit</button>
                <button type="button" className="dkg-btn dkg-btn-secondary" disabled={busy} onClick={() => void mutate(() => actOnJpbMonitorJob(job.id, job.status === 'paused' ? 'resume' : 'pause', job.revision), job.status === 'paused' ? 'Monitoring resumed.' : 'Monitoring paused.')}>
                  {job.status === 'paused' ? <Play size={14} /> : <Pause size={14} />}{job.status === 'paused' ? 'Resume' : 'Pause'}
                </button>
                <button type="button" className="dkg-btn dkg-btn-secondary" disabled={busy || job.running || job.status === 'paused'} title={job.status === 'paused' ? 'Resume monitoring before requesting a check' : undefined} onClick={() => void mutate(() => actOnJpbMonitorJob(job.id, 'refresh', job.revision), 'Check requested. The worker will report the result here.')}><RefreshCw size={14} />Check now</button>
              </div>
            </div>
            {job.batches.length > 0 && <div className="jpb-sources-table-wrap"><table className="data-table">
              <thead><tr><th>Orders</th><th>State</th><th>Trace records</th><th>Mapped source records</th><th>{job.contextGraphId ? 'New data KAs' : 'Snapshot data KAs'}</th><th>Source fetched</th><th>Last verified</th><th>Last verified snapshot</th></tr></thead>
              <tbody>{job.batches.map((batch) => <tr key={batch.id}>
                <td className="mono">{batch.orderNos.join(', ')}</td><td>{batch.status}{Boolean(batch.missingOrderNos?.length) && <div>Not returned: <span className="mono">{batch.missingOrderNos!.join(', ')}</span></div>}{batch.error && <div className="jpb-sources-error mono">{monitorErrorCode(batch.error) ?? 'MONITORING_ERROR'}</div>}</td>
                <td>{batch.recordCount ?? '—'}</td><td>{batch.mappedSourceCount ?? '—'}</td><td>{batch.dataKaCount ?? '—'}</td><td>{timeLabel(batch.fetchedAt)}</td><td>{timeLabel(batch.verifiedAt ?? batch.lastSuccessAt)}</td>
                <td>{batch.graphId && !job.contextGraphId && <button type="button" className="jpb-sources-graph-link" onClick={() => openTab({ id: `project:${batch.graphId}`, label: 'JPB snapshot', closable: true })}>Open graph</button>}
                  {batch.snapshotRevision ? <div className="mono jpb-sources-revision" title={batch.snapshotRevision}>Revision {batch.snapshotRevision}</div> : '—'}
                </td>
              </tr>)}</tbody>
            </table></div>}
          </section>)}
        </div>
        <p className="jpb-sources-hint">Batch times describe a verified SQL capture, including checks with missing orders. The JPB data queries show each order's last successful fetch and its latest absence check separately. A pending or failed check keeps the earlier committed data. A successful SQL check does not establish complete lot genealogy or PLCA measurements.</p>
      </>}
    </div>
  );
}

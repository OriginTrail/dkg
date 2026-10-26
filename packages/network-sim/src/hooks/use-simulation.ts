import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import type { OperationType } from '../types';
import type { CancellationResult, DoneEvent, ScopedSimEvent } from '../simulation-protocol';

interface SimStats { total: number; completed: number; errors: number; startedAt: number; finishedAt?: number }
interface SimulationOptions {
  name: string; opCount: number; opsPerSec: number; concurrency: number;
  kasPerPublish: number; contextGraphId: string; enabledOps: string[];
}
interface ClientRun {
  id: string;
  start: Promise<Response>;
  startAbort: AbortController;
  stream: EventSource | null;
  stats: SimStats;
  cancelling?: boolean;
}

export function useSimulation(onComplete: () => void) {
  const { dispatch, addBroadcast, addOperation, completeOperation } = useStore();
  const active = useRef<ClientRun | null>(null);
  const [running, setRunning] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [stats, setStats] = useState<SimStats | null>(null);

  const finish = useCallback((run: ClientRun, result: DoneEvent | string) => {
    if (active.current !== run) return;
    active.current = null;
    run.stream?.close();
    run.startAbort.abort();
    setRunning(false); setDisconnected(false); setFailure(typeof result === 'string' ? result : null);
    if (typeof result === 'string') setStats(null);
    else {
      Object.assign(run.stats, { completed: result.completed, errors: result.errors });
      run.stats.finishedAt = run.stats.startedAt + result.elapsedMs;
      setStats({ ...run.stats });
      dispatch({ type: 'RECONCILE_SIMULATION', id: run.id, snapshot: result });
    }
    dispatch({ type: 'STOP_SIMULATION' });
    if (typeof result !== 'string') onComplete();
  }, [dispatch, onComplete]);

  const cancel = useCallback(async (run: ClientRun) => {
    if (active.current !== run || run.cancelling) return;
    run.cancelling = true;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error('Cancellation timed out')); }, 10_000);
      });
      const result = await Promise.race([
        fetch(`/sim/stop?runId=${run.id}`, { method: 'POST', signal: controller.signal }).then(async response => {
          if (!response.ok) throw new Error('Cancellation failed');
          return response.json() as Promise<CancellationResult>;
        }), deadline,
      ]);
      if (!result.stopped || result.runId !== run.id || (result.snapshot && result.snapshot.runId !== run.id)) throw new Error('Cancellation was not confirmed');
      finish(run, result.snapshot ?? 'Cancellation confirmed. Final results are unavailable.');
    } catch {
      if (active.current === run) setFailure('Unable to confirm cancellation. Use Stop Simulation to retry.');
    } finally { clearTimeout(timeout!); run.cancelling = false; }
  }, [finish]);

  const stop = useCallback(async () => {
    if (active.current) await cancel(active.current);
  }, [cancel]);

  const start = useCallback(async (options: SimulationOptions) => {
    if (active.current) return;
    const id = `sim-${crypto.randomUUID()}`;
    const { name, contextGraphId, ...config } = options;
    const startAbort = new AbortController();
    const run: ClientRun = {
      id, startAbort, stream: null,
      stats: { total: options.opCount, completed: 0, errors: 0, startedAt: Date.now() },
      start: Promise.resolve().then(() => fetch(`/sim/start?runId=${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: startAbort.signal,
        body: JSON.stringify({ name, ...config, contextGraph: contextGraphId }),
      })),
    };
    active.current = run;
    dispatch({ type: 'START_SIMULATION', id, name, config: { ...config, contextGraphId } });
    setStats({ ...run.stats }); setRunning(true); setDisconnected(false); setFailure(null);

    const connect = () => {
      const stream = new EventSource(`/sim/events?runId=${id}`);
      run.stream = stream;
      stream.onopen = () => { if (active.current === run) setDisconnected(false); };
      stream.onerror = () => { if (active.current === run) setDisconnected(true); };
      stream.onmessage = message => {
        if (active.current !== run) return;
        try {
          const event = JSON.parse(message.data) as ScopedSimEvent;
          if (event.runId !== id) return;
          if (event.type === 'done') { finish(run, event); return; }
          if (event.type === 'unavailable') {
            // Recovery can overtake a delayed start. Unknown state is not proof
            // that the server cannot admit this ID; confirm cancellation first.
            stream.close(); run.stream = null;
            setDisconnected(true);
            void cancel(run);
            return;
          }
          if (event.type === 'op') {
            const opType = event.opType as OperationType;
            const add = opType === 'publish' || opType === 'workspace' ? addBroadcast : addOperation;
            const opId = add(opType, event.nodeId, `sim ${opType}`);
            completeOperation(opId, event.success ? 'success' : 'error', event.detail);
            dispatch({ type: 'RECORD_OP', simulationId: id, opType, success: event.success, durationMs: event.durationMs, phases: event.phases });
            run.stats.completed++;
            if (!event.success) run.stats.errors++;
          } else if (event.type === 'status') {
            run.stats.completed = event.completed; run.stats.errors = event.errors;
            dispatch({ type: 'RECONCILE_SIMULATION', id, snapshot: event });
            setFailure(null);
          } else if (event.type === 'error') run.stats.errors++;
          setStats({ ...run.stats });
        } catch { /* Ignore malformed stream data. */ }
      };
    };
    try {
      const response = await run.start;
      if (active.current !== run) return;
      if (!response.ok && response.status < 500) { finish(run, 'Simulation could not be started.'); return; }
      // A proxy 5xx may also hide an accepted or still queued upstream request.
      if (!response.ok) setDisconnected(true);
      connect();
    } catch {
      if (active.current !== run) return;
      // The request may have reached the server. Reconcile this ID before assuming it failed.
      setDisconnected(true);
      connect();
    }
  }, [dispatch, addBroadcast, addOperation, completeOperation, finish, cancel]);


  useEffect(() => () => {
    const run = active.current;
    active.current = null;
    run?.stream?.close();
    run?.startAbort.abort();
  }, []);

  return { running, disconnected, failure, stats, start, stop };
}

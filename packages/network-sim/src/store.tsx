import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import type { DevnetNode, Activity, GraphAnimation, DevnetConfig, OperationType } from './types';
import type { DoneEvent, StatusEvent, SimulationSettings } from './simulation-protocol';
import { snapshotRunAccounting, recordMetric, combineMetrics, emptyMetrics } from './simulation-metrics';
import { fetchDevnetConfig, fetchNodeStatus } from './api';

import type { LiveOpMetrics } from './simulation-metrics';
export type { LiveOpMetrics, PerTypeMetrics } from './simulation-metrics';

export type SimulationTerminalOutcome =
  | { kind: 'completed'; snapshot: DoneEvent }
  | { kind: 'cancelled' }
  | { kind: 'start-rejected' };

export interface SimulationRun {
  id: string;
  name: string;
  startedAt: number;
  finishedAt?: number;
  outcome?: { kind: SimulationTerminalOutcome['kind'] };
  metrics: LiveOpMetrics;
  error?: string;
  diagnosticCount?: number;
  config: SimulationSettings & { contextGraphId: string };
}

interface State {
  nodes: DevnetNode[];
  selectedNode: number;
  activities: Activity[];
  animations: GraphAnimation[];
  config: DevnetConfig | null;
  configError: string | null;
  liveMetrics: LiveOpMetrics;
  simulationRuns: SimulationRun[];
  activeSimulationId: string | null;
  networkMode: 'devnet' | 'testnet';
}

type StoredState = Omit<State, 'liveMetrics'> & { manualMetrics: LiveOpMetrics; liveSimulationId: string | null };

type Action =
  | { type: 'SET_CONFIG'; config: DevnetConfig }
  | { type: 'CONFIG_ERROR'; error: string }
  | { type: 'UPDATE_NODE'; id: number; online: boolean; status: DevnetNode['status'] }
  | { type: 'SELECT_NODE'; id: number }
  | { type: 'ADD_ACTIVITY'; activity: Activity }
  | { type: 'UPDATE_ACTIVITY'; id: string; status: Activity['status']; detail?: string }
  | { type: 'ADD_ANIMATION'; animation: GraphAnimation }
  | { type: 'ADD_ANIMATIONS'; animations: GraphAnimation[] }
  | { type: 'TICK_ANIMATIONS'; dt: number }
  | { type: 'REMOVE_ANIMATION'; id: string }
  | { type: 'RECORD_OP'; simulationId?: string; opType: string; success: boolean; durationMs: number; phases?: Record<string, number> }
  | { type: 'RESET_LIVE_METRICS' }
  | { type: 'START_SIMULATION'; id: string; name: string; config: SimulationRun['config'] }
  | { type: 'RECONCILE_SIMULATION'; id: string; snapshot: StatusEvent }
  | { type: 'SIMULATION_ERROR'; id: string; message: string }
  | { type: 'COMPLETE_SIMULATION'; id: string; outcome: SimulationTerminalOutcome };

const MAX_ACTIVITIES = 200;

function reducer(state: StoredState, action: Action): StoredState {
  switch (action.type) {
    case 'SET_CONFIG': {
      const mode = action.config.network ?? 'devnet';
      const nodes: DevnetNode[] = action.config.nodes.map((n) => ({
        id: n.id,
        name: n.name || `${mode}-node-${n.id}`,
        apiPort: n.apiPort,
        listenPort: n.listenPort,
        nodeRole: n.nodeRole as 'core' | 'edge',
        online: false,
        status: null,
      }));
      return { ...state, config: action.config, configError: null, nodes, networkMode: mode };
    }
    case 'CONFIG_ERROR':
      return { ...state, configError: action.error };
    case 'UPDATE_NODE':
      return {
        ...state,
        nodes: state.nodes.map((n) =>
          n.id === action.id ? { ...n, online: action.online, status: action.status } : n,
        ),
      };
    case 'SELECT_NODE':
      return { ...state, selectedNode: action.id };
    case 'ADD_ACTIVITY':
      return {
        ...state,
        activities: [action.activity, ...state.activities].slice(0, MAX_ACTIVITIES),
      };
    case 'UPDATE_ACTIVITY':
      return {
        ...state,
        activities: state.activities.map((a) =>
          a.id === action.id
            ? { ...a, status: action.status, detail: action.detail ?? a.detail }
            : a,
        ),
      };
    case 'ADD_ANIMATION':
      return { ...state, animations: [...state.animations, action.animation] };
    case 'ADD_ANIMATIONS':
      return { ...state, animations: [...state.animations, ...action.animations] };
    case 'TICK_ANIMATIONS':
      return {
        ...state,
        animations: state.animations
          .map((a) => ({ ...a, progress: a.progress + a.speed * action.dt }))
          .filter((a) => a.progress < 1),
      };
    case 'REMOVE_ANIMATION':
      return { ...state, animations: state.animations.filter((a) => a.id !== action.id) };
    case 'RECORD_OP': {
      if (!action.simulationId) return { ...state, manualMetrics: recordMetric(state.manualMetrics, action) };
      if (action.simulationId !== state.activeSimulationId) return state;
      return { ...state, simulationRuns: state.simulationRuns.map(run =>
        run.id === action.simulationId ? { ...run, metrics: recordMetric(run.metrics, action) } : run) };
    }
    case 'RESET_LIVE_METRICS':
      return { ...state, manualMetrics: emptyMetrics(), liveSimulationId: state.activeSimulationId };
    case 'START_SIMULATION': {
      const run: SimulationRun = {
        id: action.id,
        name: action.name,
        startedAt: Date.now(),
        metrics: emptyMetrics(),
        config: action.config,
      };
      return {
        ...state,
        activeSimulationId: action.id,
        simulationRuns: [...state.simulationRuns, run],
        manualMetrics: emptyMetrics(), liveSimulationId: action.id,
      };
    }
    case 'RECONCILE_SIMULATION': {
      if (action.id !== state.activeSimulationId) return state;
      const run = state.simulationRuns.find(r => r.id === action.id)!;
      const updated = { ...run, ...snapshotRunAccounting(action.snapshot, run.metrics), error: undefined };
      return { ...state,
        simulationRuns: state.simulationRuns.map(r => r.id === action.id ? updated : r) };
    }
    case 'SIMULATION_ERROR': {
      if (action.id !== state.activeSimulationId) return state;
      return { ...state, simulationRuns: state.simulationRuns.map(run => run.id === action.id
        ? { ...run, error: action.message, diagnosticCount: (run.diagnosticCount ?? 0) + 1 } : run) };
    }
    case 'COMPLETE_SIMULATION': {
      if (action.id !== state.activeSimulationId) return state;
      const snapshot = action.outcome.kind === 'completed' ? action.outcome.snapshot : undefined;
      const runs = state.simulationRuns.map(run => {
        if (run.id !== action.id) return run;
        return { ...run, outcome: { kind: action.outcome.kind }, ...(snapshot ? snapshotRunAccounting(snapshot, run.metrics) : {}),
          finishedAt: snapshot ? run.startedAt + snapshot.elapsedMs : Date.now(),
        };
      });
      return { ...state, activeSimulationId: null, simulationRuns: runs };
    }
    default:
      return state;
  }
}

const initial: StoredState = {
  nodes: [],
  selectedNode: 1,
  activities: [],
  animations: [],
  config: null,
  configError: null,
  manualMetrics: emptyMetrics(), liveSimulationId: null,
  simulationRuns: [],
  activeSimulationId: null,
  networkMode: 'devnet',
};

interface StoreCtx {
  state: State;
  dispatch: React.Dispatch<Action>;
  addOperation: (
    type: OperationType,
    sourceNode: number,
    label: string,
    targetNode?: number,
  ) => string;
  addBroadcast: (
    type: OperationType,
    sourceNode: number,
    label: string,
  ) => string;
  completeOperation: (id: string, status: 'success' | 'error', detail?: string) => void;
}

const Ctx = createContext<StoreCtx>(null!);

export function useStore() {
  return useContext(Ctx);
}

let activityCounter = 0;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const stateRef = useRef(state);
  stateRef.current = state;

  const addOperation = useCallback(
    (type: OperationType, sourceNode: number, label: string, targetNode?: number) => {
      const id = `op-${++activityCounter}`;
      dispatch({
        type: 'ADD_ACTIVITY',
        activity: { id, ts: Date.now(), type, sourceNode, targetNode, label, status: 'pending' },
      });
      if (targetNode != null && targetNode !== sourceNode) {
        dispatch({
          type: 'ADD_ANIMATION',
          animation: {
            id,
            from: sourceNode - 1,
            to: targetNode - 1,
            type,
            progress: 0,
            speed: 0.6,
          },
        });
      } else {
        dispatch({
          type: 'ADD_ANIMATION',
          animation: {
            id,
            from: sourceNode - 1,
            to: sourceNode - 1,
            type,
            progress: 0,
            speed: 0.4,
          },
        });
      }
      return id;
    },
    [],
  );

  const addBroadcast = useCallback(
    (type: OperationType, sourceNode: number, label: string) => {
      const id = `op-${++activityCounter}`;
      dispatch({
        type: 'ADD_ACTIVITY',
        activity: { id, ts: Date.now(), type, sourceNode, label, status: 'pending' },
      });
      const targets = stateRef.current.nodes.filter(
        (n) => n.id !== sourceNode && n.online,
      );
      if (targets.length === 0) {
        dispatch({
          type: 'ADD_ANIMATION',
          animation: { id, from: sourceNode - 1, to: sourceNode - 1, type, progress: 0, speed: 0.4 },
        });
      } else {
        dispatch({
          type: 'ADD_ANIMATIONS',
          animations: targets.map((t, i) => ({
            id: `${id}-b${i}`,
            from: sourceNode - 1,
            to: t.id - 1,
            type,
            progress: -(i * 0.08),
            speed: 0.5,
          })),
        });
      }
      return id;
    },
    [],
  );

  const completeOperation = useCallback(
    (id: string, status: 'success' | 'error', detail?: string) => {
      dispatch({ type: 'UPDATE_ACTIVITY', id, status, detail });
    },
    [],
  );

  useEffect(() => {
    fetchDevnetConfig()
      .then((config) => {
        if (config.nodes.length > 0) {
          dispatch({ type: 'SET_CONFIG', config });
        } else {
          const isTestnet = config.network === 'testnet';
          const defaultNodes = isTestnet
            ? [{ id: 1, name: 'testnet-node', apiPort: 9200, listenPort: 0, nodeRole: 'edge' }]
            : Array.from({ length: 6 }, (_, i) => ({
                id: i + 1,
                name: `devnet-node-${i + 1}`,
                apiPort: 9201 + i,
                listenPort: 10001 + i,
                nodeRole: i === 0 ? 'core' : ('edge' as const),
              }));
          dispatch({ type: 'SET_CONFIG', config: { ...config, nodes: defaultNodes } });
        }
      })
      .catch(() => {
        const fallback: DevnetConfig = {
          nodes: Array.from({ length: 6 }, (_, i) => ({
            id: i + 1,
            name: `devnet-node-${i + 1}`,
            apiPort: 9201 + i,
            listenPort: 10001 + i,
            nodeRole: i === 0 ? 'core' : ('edge' as const),
          })),
          contracts: {},
          hubAddress: '',
          chainRpc: 'http://127.0.0.1:8545',
        };
        dispatch({ type: 'SET_CONFIG', config: fallback });
      });
  }, []);

  useEffect(() => {
    if (!state.nodes.length) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    let allOfflineStreak = 0;

    const poll = async () => {
      const results = await Promise.allSettled(
        stateRef.current.nodes.map(async (node) => {
          try {
            const status = await fetchNodeStatus(node.id);
            return { id: node.id, online: true, status };
          } catch {
            return { id: node.id, online: false, status: null };
          }
        }),
      );

      if (cancelled) return;
      let anyOnline = false;
      for (const r of results) {
        if (r.status === 'fulfilled') {
          dispatch({ type: 'UPDATE_NODE', id: r.value.id, online: r.value.online, status: r.value.status });
          if (r.value.online) anyOnline = true;
        }
      }

      allOfflineStreak = anyOnline ? 0 : allOfflineStreak + 1;
      const simRunning = !!stateRef.current.activeSimulationId;
      const baseDelay = simRunning ? 10000 : 3000;
      const delay = anyOnline ? baseDelay : Math.min(15000, baseDelay + allOfflineStreak * 2000);
      timeoutId = setTimeout(poll, delay);
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [state.nodes.length]);

  useEffect(() => {
    let last = performance.now();
    let raf: number;
    const tick = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      dispatch({ type: 'TICK_ANIMATIONS', dt });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const { manualMetrics, liveSimulationId, ...visibleState } = state;
  const liveRun = state.simulationRuns.find(run => run.id === liveSimulationId);
  const liveMetrics = useMemo(() => combineMetrics(manualMetrics, liveRun?.metrics), [manualMetrics, liveRun?.metrics]);
  const view: State = { ...visibleState, liveMetrics };
  return (
    <Ctx.Provider value={{ state: view, dispatch, addOperation, addBroadcast, completeOperation }}>
      {children}
    </Ctx.Provider>
  );
}

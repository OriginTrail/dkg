import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import type { DevnetNode, Activity, GraphAnimation, DevnetConfig, OperationType } from './types';
import { fetchDevnetConfig, fetchNodeStatus } from './api';

export interface LiveOpMetrics {
  total: number;
  success: number;
  errors: number;
  byType: Record<string, { total: number; success: number; errors: number }>;
  /** Rolling window of recent op timestamps for ops/sec calculation */
  recentTimestamps: number[];
}

export interface SimulationRun {
  id: string;
  name: string;
  startedAt: number;
  finishedAt?: number;
  metrics: LiveOpMetrics;
  config: {
    opCount: number;
    opsPerSec: number;
    concurrency: number;
    paranet: string;
    enabledOps: string[];
  };
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

type Action =
  | { type: 'SET_CONFIG'; config: DevnetConfig }
  | { type: 'CONFIG_ERROR'; error: string }
  | { type: 'UPDATE_NODE'; id: number; online: boolean; status: DevnetNode['status'] }
  | { type: 'SELECT_NODE'; id: number }
  | { type: 'ADD_ACTIVITY'; activity: Activity }
  | { type: 'UPDATE_ACTIVITY'; id: string; status: Activity['status']; detail?: string }
  | { type: 'ADD_ANIMATION'; animation: GraphAnimation }
  | { type: 'TICK_ANIMATIONS'; dt: number }
  | { type: 'REMOVE_ANIMATION'; id: string }
  | { type: 'RECORD_OP'; opType: string; success: boolean; durationMs: number }
  | { type: 'RESET_LIVE_METRICS' }
  | { type: 'START_SIMULATION'; id: string; name: string; config: SimulationRun['config'] }
  | { type: 'STOP_SIMULATION' };

const MAX_ACTIVITIES = 200;

function reducer(state: State, action: Action): State {
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
      const m = { ...state.liveMetrics };
      m.total++;
      if (action.success) m.success++; else m.errors++;
      const bt = m.byType[action.opType] ?? { total: 0, success: 0, errors: 0 };
      bt.total++;
      if (action.success) bt.success++; else bt.errors++;
      m.byType = { ...m.byType, [action.opType]: bt };
      const now = Date.now();
      m.recentTimestamps = [...m.recentTimestamps.filter((t) => now - t < 10_000), now];

      let runs = state.simulationRuns;
      if (state.activeSimulationId) {
        runs = runs.map((r) => {
          if (r.id !== state.activeSimulationId) return r;
          const rm = { ...r.metrics };
          rm.total++;
          if (action.success) rm.success++; else rm.errors++;
          const rbt = rm.byType[action.opType] ?? { total: 0, success: 0, errors: 0 };
          rbt.total++;
          if (action.success) rbt.success++; else rbt.errors++;
          rm.byType = { ...rm.byType, [action.opType]: rbt };
          rm.recentTimestamps = [...rm.recentTimestamps.filter((t) => now - t < 10_000), now];
          return { ...r, metrics: rm };
        });
      }
      return { ...state, liveMetrics: m, simulationRuns: runs };
    }
    case 'RESET_LIVE_METRICS':
      return { ...state, liveMetrics: { total: 0, success: 0, errors: 0, byType: {}, recentTimestamps: [] } };
    case 'START_SIMULATION': {
      const run: SimulationRun = {
        id: action.id,
        name: action.name,
        startedAt: Date.now(),
        metrics: { total: 0, success: 0, errors: 0, byType: {}, recentTimestamps: [] },
        config: action.config,
      };
      return {
        ...state,
        activeSimulationId: action.id,
        simulationRuns: [...state.simulationRuns, run],
        liveMetrics: { total: 0, success: 0, errors: 0, byType: {}, recentTimestamps: [] },
      };
    }
    case 'STOP_SIMULATION': {
      const runs = state.simulationRuns.map((r) =>
        r.id === state.activeSimulationId ? { ...r, finishedAt: Date.now() } : r,
      );
      return { ...state, activeSimulationId: null, simulationRuns: runs };
    }
    default:
      return state;
  }
}

const initial: State = {
  nodes: [],
  selectedNode: 1,
  activities: [],
  animations: [],
  config: null,
  configError: null,
  liveMetrics: { total: 0, success: 0, errors: 0, byType: {}, recentTimestamps: [] },
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
        targets.forEach((t, i) => {
          dispatch({
            type: 'ADD_ANIMATION',
            animation: {
              id: `${id}-b${i}`,
              from: sourceNode - 1,
              to: t.id - 1,
              type,
              progress: -(i * 0.08),
              speed: 0.5,
            },
          });
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
            : Array.from({ length: 5 }, (_, i) => ({
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
          nodes: Array.from({ length: 5 }, (_, i) => ({
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
      let anyOnline = false;
      for (const node of stateRef.current.nodes) {
        if (cancelled) break;
        try {
          const status = await fetchNodeStatus(node.id);
          dispatch({ type: 'UPDATE_NODE', id: node.id, online: true, status });
          anyOnline = true;
        } catch {
          dispatch({ type: 'UPDATE_NODE', id: node.id, online: false, status: null });
        }
      }

      if (cancelled) return;
      allOfflineStreak = anyOnline ? 0 : allOfflineStreak + 1;
      const delay = anyOnline ? 3000 : Math.min(10000, 3000 + allOfflineStreak * 2000);
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

  return (
    <Ctx.Provider value={{ state, dispatch, addOperation, addBroadcast, completeOperation }}>
      {children}
    </Ctx.Provider>
  );
}

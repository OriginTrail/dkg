import { useState, useCallback } from 'react';
import { SIMULATION_OPERATIONS, type SimOp } from '../simulation-protocol';
import { useSimulation } from './use-simulation';

/** Session and form state live with ControlPanel, independently of the selected view. */
let simCounter = 0;

export function useSimulationController() {
  const [simName, setSimName] = useState(() => `Simulation #${++simCounter}`);
  const [opCount, setOpCount] = useState(500);
  const [opsPerSec, setOpsPerSec] = useState(10);
  const [concurrency, setConcurrency] = useState(10);
  const [kasPerPublish, setKasPerPublish] = useState(1);
  const [contextGraphId, setContextGraphId] = useState('devnet-test');
  const [enabledOps, setEnabledOps] = useState<Set<SimOp>>(new Set(SIMULATION_OPERATIONS));
  const onComplete = useCallback(() => setSimName(`Simulation #${++simCounter}`), []);
  const { running, disconnected, failure, stats, start, stop: stopSimulation } = useSimulation(onComplete);

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

  const runSimulation = () => start({
    name: simName || `Simulation #${simCounter}`,
    opCount, opsPerSec, concurrency, kasPerPublish, contextGraphId, enabledOps: Array.from(enabledOps),
  });

  return { simName, setSimName, opCount, setOpCount, opsPerSec, setOpsPerSec, concurrency, setConcurrency,
    kasPerPublish, setKasPerPublish, contextGraphId, setContextGraphId, enabledOps, toggleOp,
    running, disconnected, failure, stats, runSimulation, stopSimulation };
}

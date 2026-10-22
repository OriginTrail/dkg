import { StorePriorityScheduler } from './store-priority-scheduler.js';

/** Process-wide disk budget, independent of SPARQL HTTP request admission. */
export const managedPersistenceScheduler = new StorePriorityScheduler({
  maxConcurrent: 2,
  ackReservedSlots: 0,
  healthReservedSlots: 0,
  normalReservedSlots: 0,
  backgroundReservedSlots: 0,
  queueLimits: 64,
  queueWaitTimeoutMs: 10_000,
});

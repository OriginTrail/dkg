import { availableParallelism, cpus } from 'node:os';
import { performance, type EventLoopUtilization } from 'node:perf_hooks';
import { memoryUsage } from 'node:process';
import { getHeapStatistics } from 'node:v8';
import type { StorePressureSnapshot, TripleStore } from '@origintrail-official/dkg-storage';
import {
  MAX_SYNC_ADAPTIVE_INFLIGHT,
  type AdaptiveCapacitySample,
} from './adaptive-capacity.js';

export interface CpuTimeSnapshot {
  idle: number;
  total: number;
}

export interface AdaptiveCapacitySamplerDependencies {
  readCpuTimes?: () => CpuTimeSnapshot;
  readEventLoopUtilization?: () => EventLoopUtilization;
  eventLoopUtilizationDelta?: (
    current: EventLoopUtilization,
    previous: EventLoopUtilization,
  ) => number;
  readHeapRatio?: () => number | undefined;
}

function defaultCpuTimes(): CpuTimeSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

function intervalCpuUtilization(
  current: CpuTimeSnapshot,
  previous: CpuTimeSnapshot,
): number | undefined {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0 || idleDelta < 0) return undefined;
  return Math.max(0, Math.min(1, 1 - (idleDelta / totalDelta)));
}

function defaultHeapRatio(): number | undefined {
  const heapLimit = getHeapStatistics().heap_size_limit;
  if (!Number.isFinite(heapLimit) || heapLimit <= 0) return undefined;
  return Math.max(0, Math.min(1, memoryUsage().heapUsed / heapLimit));
}

function storeSample(store: TripleStore): AdaptiveCapacitySample['store'] {
  let pressure: StorePressureSnapshot | undefined;
  try {
    pressure = store.getPressureSnapshot?.();
  } catch {
    return { telemetryAvailable: false };
  }
  if (!pressure) return { telemetryAvailable: false };
  return {
    telemetryAvailable: true,
    ackQueued: pressure.ackQueued,
    healthQueued: pressure.healthQueued ?? 0,
    normalQueued: pressure.normalQueued,
    backgroundQueued: pressure.backgroundQueued,
  };
}

/**
 * Node-local interval sampler. Ordinary full store utilization is deliberately
 * not classified as saturation: critical store state requires queue-age or
 * no-progress evidence that the current pressure API does not expose.
 */
export class AdaptiveCapacitySampler {
  private readonly readCpuTimes: () => CpuTimeSnapshot;
  private readonly readEventLoopUtilization: () => EventLoopUtilization;
  private readonly eventLoopUtilizationDelta: (
    current: EventLoopUtilization,
    previous: EventLoopUtilization,
  ) => number;
  private readonly readHeapRatio: () => number | undefined;
  private previousCpuTimes: CpuTimeSnapshot;
  private previousEventLoopUtilization: EventLoopUtilization;

  constructor(
    private readonly store: TripleStore,
    dependencies: AdaptiveCapacitySamplerDependencies = {},
  ) {
    this.readCpuTimes = dependencies.readCpuTimes ?? defaultCpuTimes;
    this.readEventLoopUtilization = dependencies.readEventLoopUtilization
      ?? (() => performance.eventLoopUtilization());
    this.eventLoopUtilizationDelta = dependencies.eventLoopUtilizationDelta
      ?? ((current, previous) => performance.eventLoopUtilization(current, previous).utilization);
    this.readHeapRatio = dependencies.readHeapRatio ?? defaultHeapRatio;
    this.previousCpuTimes = this.readCpuTimes();
    this.previousEventLoopUtilization = this.readEventLoopUtilization();
  }

  sample(demand: boolean): AdaptiveCapacitySample {
    const currentCpuTimes = this.readCpuTimes();
    const cpuUtilization = intervalCpuUtilization(currentCpuTimes, this.previousCpuTimes);
    this.previousCpuTimes = currentCpuTimes;

    const currentEventLoopUtilization = this.readEventLoopUtilization();
    const eventLoopUtilization = this.eventLoopUtilizationDelta(
      currentEventLoopUtilization,
      this.previousEventLoopUtilization,
    );
    this.previousEventLoopUtilization = currentEventLoopUtilization;

    const heapRatio = this.readHeapRatio();
    return {
      demand,
      ...(cpuUtilization !== undefined ? { cpuUtilization } : {}),
      ...(Number.isFinite(eventLoopUtilization)
        ? { eventLoopUtilization: Math.max(0, Math.min(1, eventLoopUtilization)) }
        : {}),
      ...(heapRatio !== undefined ? { heapRatio } : {}),
      store: storeSample(this.store),
    };
  }
}

export interface AdaptiveInflightHardMaxInput {
  operatorMax?: number;
  parallelism?: number;
  storePressure?: StorePressureSnapshot;
}

/** Resolve the largest requester cap the controller may ever reach. */
export function deriveAdaptiveInflightHardMax(
  input: AdaptiveInflightHardMaxInput = {},
): number {
  const operatorMax = input.operatorMax ?? MAX_SYNC_ADAPTIVE_INFLIGHT;
  const parallelism = input.parallelism ?? availableParallelism();
  if (!Number.isInteger(operatorMax) || operatorMax < 1) {
    throw new TypeError('adaptive operator maximum must be a positive integer');
  }
  if (!Number.isInteger(parallelism) || parallelism < 1) {
    throw new TypeError('available parallelism must be a positive integer');
  }
  const hardwareMax = Math.max(1, Math.floor(parallelism / 2));
  const storeMax = input.storePressure
    ? Math.max(
        1,
        input.storePressure.maxConcurrent
          - input.storePressure.ackReservedSlots
          - (input.storePressure.healthReservedSlots ?? 0)
          - (input.storePressure.normalReservedSlots ?? 0),
      )
    : MAX_SYNC_ADAPTIVE_INFLIGHT;
  return Math.min(MAX_SYNC_ADAPTIVE_INFLIGHT, operatorMax, hardwareMax, storeMax);
}

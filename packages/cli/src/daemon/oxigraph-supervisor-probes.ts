import type { ChildProcess } from 'node:child_process';
import type { OxigraphLaunchStrategy } from './oxigraph-launch-strategy.js';
import type { OxigraphServerIo } from './oxigraph-server-contract.js';
import {
  boundedOxigraphPhaseDelayMsV1,
  remainingOxigraphDeadlineMsV1,
  sleepOxigraphSupervisorV1,
} from './oxigraph-supervisor-lifecycle.js';

/** Upper bound of the ss/lsof/fuser ownership lookup used by the supervisor. */
const LISTENER_OWNERSHIP_PROBE_BUDGET_MS = 6_500;
const PORT_RELEASE_PROBE_ATTEMPTS = 5;

export type OxigraphBindProbeResultV1 =
  | 'serving'
  | 'refused'
  | 'inconclusive';

export interface OxigraphPortReleaseProofV1 {
  released: boolean;
  last: OxigraphBindProbeResultV1;
  owner: number | null;
}

interface OxigraphSupervisorProbesOptionsV1 {
  host: string;
  port: number;
  queryEndpoint: string;
  readyIntervalMs: number;
  stopGraceMs: number;
  io: Pick<OxigraphServerIo, 'fetch' | 'findListenOwnerPid'>;
  launchStrategy: OxigraphLaunchStrategy;
  currentChild: () => ChildProcess | null;
  childAlive: () => boolean;
}

/**
 * Stateless listener evidence boundary for one managed Oxigraph supervisor.
 * It probes and classifies only; lifecycle and lease transitions stay with the
 * serialized supervisor.
 */
export class OxigraphSupervisorProbesV1 {
  readonly #options: OxigraphSupervisorProbesOptionsV1;

  constructor(options: OxigraphSupervisorProbesOptionsV1) {
    this.#options = options;
  }

  async probeBind(
    absoluteDeadlineMs?: number,
  ): Promise<OxigraphBindProbeResultV1> {
    try {
      const timeoutMs = boundedOxigraphPhaseDelayMsV1(
        this.#options.readyIntervalMs + 1_000,
        absoluteDeadlineMs,
      );
      const res = await this.#options.io.fetch(this.#options.queryEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          Accept: 'application/sparql-results+json',
        },
        body: 'ASK { ?s ?p ?o }',
        signal: AbortSignal.timeout(timeoutMs),
      });
      void res;
      return 'serving';
    } catch (error) {
      return isConnectionRefusedV1(error) ? 'refused' : 'inconclusive';
    }
  }

  async resolveListenOwner(child: ChildProcess): Promise<number | null> {
    try {
      return await this.#options.launchStrategy.resolveListenerPid(
        child,
        this.#options.port,
        this.#options.host,
        this.#options.io.findListenOwnerPid,
      );
    } catch {
      return null;
    }
  }

  async probeReady(absoluteDeadlineMs?: number): Promise<number | null> {
    const child = this.#options.currentChild();
    if (!child || !this.#options.childAlive()) return null;
    if (!(await this.#endpointAnswers(absoluteDeadlineMs))) return null;
    boundedOxigraphPhaseDelayMsV1(1, absoluteDeadlineMs);
    const remaining = remainingOxigraphDeadlineMsV1(absoluteDeadlineMs);
    if (remaining !== undefined && remaining < LISTENER_OWNERSHIP_PROBE_BUDGET_MS) {
      return null;
    }
    const listenerPid = await this.resolveListenOwner(child);
    boundedOxigraphPhaseDelayMsV1(1, absoluteDeadlineMs);
    return listenerPid !== null && this.#options.childAlive() ? listenerPid : null;
  }

  async provePortRelease(
    exited: ChildProcess | null,
    absoluteDeadlineMs?: number,
  ): Promise<OxigraphPortReleaseProofV1> {
    const interval = Math.max(
      1,
      Math.floor(this.#options.stopGraceMs / PORT_RELEASE_PROBE_ATTEMPTS),
    );
    let last: OxigraphBindProbeResultV1 = 'inconclusive';
    for (let attempt = 1; attempt <= PORT_RELEASE_PROBE_ATTEMPTS; attempt += 1) {
      if ((remainingOxigraphDeadlineMsV1(absoluteDeadlineMs) ?? 1) <= 0) break;
      last = await this.probeBind(absoluteDeadlineMs);
      if (last === 'refused') return { released: true, last, owner: null };
      if (attempt === PORT_RELEASE_PROBE_ATTEMPTS) break;
      await sleepOxigraphSupervisorV1(
        boundedOxigraphPhaseDelayMsV1(interval, absoluteDeadlineMs),
      );
    }
    const owner = exited === null || absoluteDeadlineMs !== undefined
      ? null
      : await this.resolveListenOwner(exited);
    return { released: false, last, owner };
  }

  async #endpointAnswers(absoluteDeadlineMs?: number): Promise<boolean> {
    try {
      const timeoutMs = boundedOxigraphPhaseDelayMsV1(
        this.#options.readyIntervalMs + 1_000,
        absoluteDeadlineMs,
      );
      const res = await this.#options.io.fetch(this.#options.queryEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          Accept: 'application/sparql-results+json',
        },
        body: 'ASK { ?s ?p ?o }',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/** Only an active OS refusal proves that the managed bind is free. */
function isConnectionRefusedV1(error: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (candidate: unknown): boolean => {
    if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    const node = candidate as { code?: unknown; cause?: unknown; errors?: unknown };
    if (node.code === 'ECONNREFUSED') return true;
    if (Array.isArray(node.errors) && node.errors.some(walk)) return true;
    return walk(node.cause);
  };
  return walk(error);
}

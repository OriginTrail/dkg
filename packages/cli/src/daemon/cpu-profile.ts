// Records a V8 CPU profile of the daemon's main thread for the operator-only
// `POST /api/diagnostics/cpu-profile` route. The inspector session runs in
// process on this thread: no inspector port or listener is opened, and the
// session is disconnected when the recording ends or fails.
//
// Ending a session that enabled the profiler (explicitly or by disconnecting)
// also resets V8's precise coverage for the whole isolate. That is harmless in
// a node, but a test recording a real profile must run it in a child process
// so the test runner's coverage is not lost.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CpuProfileResult } from '../cpu-profile-wire.js';

/** The part of a `node:inspector/promises` Session the recorder uses. */
export interface CpuProfilerSession {
  connect(): void;
  post(method: string): Promise<unknown>;
  disconnect(): void;
}

/** A profile is already being recorded; only one runs at a time. */
export class CpuProfileBusyError extends Error {
  readonly code = 'CPU_PROFILE_IN_PROGRESS';
  constructor() {
    super('A CPU profile is already being recorded on this node; try again when it ends.');
  }
}

/** The node cannot record a profile now: it is shutting down, or this Node.js build has no inspector. */
export class CpuProfileUnavailableError extends Error {
  readonly code = 'CPU_PROFILE_UNAVAILABLE';
}

async function openInspectorSession(): Promise<CpuProfilerSession> {
  const { Session } = await import('node:inspector/promises');
  return new Session();
}

export interface CpuProfileRecording {
  readonly seconds: number;
  readonly clamped: boolean;
  /** Directory the profile file is written into; created when missing. */
  readonly directory: string;
}

export class CpuProfileRecorder {
  readonly #openSession: () => Promise<CpuProfilerSession>;
  readonly #now: () => number;
  /** Set while a profile runs; ends its wait early (`true`) or at its duration (`false`). */
  #wake: ((stoppedEarly: boolean) => void) | undefined;
  #ended = false;

  constructor(deps: { openSession?: () => Promise<CpuProfilerSession>; now?: () => number } = {}) {
    this.#openSession = deps.openSession ?? openInspectorSession;
    this.#now = deps.now ?? Date.now;
  }

  /** Record for `seconds`, write `<directory>/cpu-<start time>.cpuprofile` and return where. */
  async record(recording: CpuProfileRecording): Promise<CpuProfileResult> {
    if (this.#ended) throw new CpuProfileUnavailableError('The node is shutting down; no CPU profile was recorded.');
    if (this.#wake !== undefined) throw new CpuProfileBusyError();
    let wake!: (stoppedEarly: boolean) => void;
    const woken = new Promise<boolean>((resolve) => { wake = resolve; });
    this.#wake = wake;
    try {
      return await this.#record(recording, wake, woken);
    } finally {
      this.#wake = undefined;
    }
  }

  /** Shutdown: refuse new profiles and stop the running one now; it is still written and its session closed. */
  end(): void {
    this.#ended = true;
    this.#wake?.(true);
  }

  async #record(
    recording: CpuProfileRecording,
    wake: (stoppedEarly: boolean) => void,
    woken: Promise<boolean>,
  ): Promise<CpuProfileResult> {
    let session: CpuProfilerSession;
    try {
      session = await this.#openSession();
      session.connect();
    } catch (cause) {
      throw new CpuProfileUnavailableError('This Node.js runtime cannot open an inspector session.', { cause });
    }
    try {
      await session.post('Profiler.enable');
      await session.post('Profiler.start');
      const startedAt = this.#now();
      const timer = setTimeout(() => wake(false), recording.seconds * 1000);
      const stoppedEarly = await woken;
      clearTimeout(timer);
      const { profile } = await session.post('Profiler.stop') as { profile: unknown };
      const recordedMs = this.#now() - startedAt;
      const json = JSON.stringify(profile);
      await mkdir(recording.directory, { recursive: true, mode: 0o700 });
      const path = join(recording.directory, `cpu-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
      await writeFile(path, json, { flag: 'wx', mode: 0o600 });
      return { path, seconds: recording.seconds, clamped: recording.clamped, recordedMs, bytes: Buffer.byteLength(json), stoppedEarly };
    } finally {
      // Disconnecting ends the session: V8 disables its profiler, which also
      // stops a recording that an error left running.
      session.disconnect();
    }
  }
}

/** The daemon's one recorder: one profile at a time per process. */
export const daemonCpuProfiles = new CpuProfileRecorder();

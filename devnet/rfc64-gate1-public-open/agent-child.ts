import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  ChildProcessRegistry,
  type ProcessExitEvidence,
  type TrackedChildProcess,
} from '../rfc64-persistence-lifecycle/process-lifecycle.js';
import { GATE1_AGENT_EVENT_PREFIX } from './model.js';

const DEFAULT_EVENT_TIMEOUT_MS = 45_000;
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_EVENT_LINE_BYTES = 1_000_000;

export interface Gate1AgentEvent {
  readonly event: string;
  readonly requestId?: string;
  readonly role: 'author' | 'receiver';
  readonly [key: string]: unknown;
}

export interface Gate1AgentSpawnSpec {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface Gate1AgentChildOptions {
  readonly eventTimeoutMs?: number;
  readonly registry: ChildProcessRegistry;
  readonly role: 'author' | 'receiver';
  readonly spawn: Gate1AgentSpawnSpec;
}

interface PendingEvent {
  readonly expectedEvent: string;
  readonly reject: (error: Error) => void;
  readonly requestId: string | null;
  readonly resolve: (event: Gate1AgentEvent) => void;
  readonly timer: NodeJS.Timeout;
}

export class Gate1AgentChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly tracked: TrackedChildProcess;
  readonly #eventTimeoutMs: number;
  readonly #events: Gate1AgentEvent[] = [];
  readonly #pending = new Set<PendingEvent>();
  #stderr = '';
  #stdout = '';
  #lineBuffer = '';

  constructor(readonly options: Gate1AgentChildOptions) {
    this.#eventTimeoutMs = options.eventTimeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#eventTimeoutMs) || this.#eventTimeoutMs < 1) {
      throw new TypeError('eventTimeoutMs must be a positive safe integer');
    }
    this.child = spawn(options.spawn.command, [...options.spawn.args], {
      cwd: options.spawn.cwd,
      env: options.spawn.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.tracked = options.registry.track(this.child);
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.#stderr = appendBounded(this.#stderr, chunk);
    });
    this.child.once('error', (error) => this.rejectAll(error));
    void this.tracked.closed.then((exit) => {
      if (this.#pending.size === 0) return;
      this.rejectAll(new Error(
        `${this.options.role} DKGAgent closed before its expected event: ${JSON.stringify(exit)}\n`
          + `stdout tail:\n${this.#stdout}\nstderr tail:\n${this.#stderr}`,
      ));
    });
  }

  get role(): 'author' | 'receiver' {
    return this.options.role;
  }

  waitFor(expectedEvent: string, requestId: string | null = null): Promise<Gate1AgentEvent> {
    const existing = this.#events.find((event) =>
      event.event === expectedEvent && (requestId === null || event.requestId === requestId));
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<Gate1AgentEvent>((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => {
        this.#pending.delete(pending);
        rejectEvent(new Error(
          `${this.role} DKGAgent timed out waiting for ${expectedEvent}/${requestId ?? '*'}\n`
            + `stdout tail:\n${this.#stdout}\nstderr tail:\n${this.#stderr}`,
        ));
      }, this.#eventTimeoutMs);
      const pending: PendingEvent = {
        expectedEvent,
        reject: rejectEvent,
        requestId,
        resolve: resolveEvent,
        timer,
      };
      this.#pending.add(pending);
    });
  }

  async request(
    command: string,
    requestId: string,
    expectedEvent: string,
    input?: unknown,
  ): Promise<Gate1AgentEvent> {
    const payload = input === undefined
      ? { command, requestId }
      : { command, input, requestId };
    const line = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) {
      throw new Error('Gate 1 adapter command exceeds the 1 MiB process-protocol bound');
    }
    const event = this.waitFor(expectedEvent, requestId);
    try {
      await new Promise<void>((resolveWrite, rejectWrite) => {
        this.child.stdin.write(line, (error) => {
          if (error === null || error === undefined) resolveWrite();
          else rejectWrite(error);
        });
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.rejectAll(failure);
      await event.catch(() => undefined);
      throw failure;
    }
    return event;
  }

  async stop(requestId: string): Promise<ProcessExitEvidence> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return this.tracked.closed;
    }
    await this.request('stop', requestId, 'stopped');
    const exit = await this.tracked.closed;
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`${this.role} DKGAgent did not stop cleanly: ${JSON.stringify(exit)}`);
    }
    return exit;
  }

  async killRestartBoundary(requestId: string): Promise<ProcessExitEvidence> {
    await this.request('killRestart', requestId, 'kill-restart-ready');
    const exit = await this.options.registry.terminateAndWait(this.tracked, 'SIGKILL');
    if (exit.code !== null || exit.signal !== 'SIGKILL') {
      throw new Error(`${this.role} crash boundary was not SIGKILL: ${JSON.stringify(exit)}`);
    }
    return exit;
  }

  private consumeStdout(chunk: string): void {
    this.#stdout = appendBounded(this.#stdout, chunk);
    this.#lineBuffer += chunk;
    if (Buffer.byteLength(this.#lineBuffer) > MAX_EVENT_LINE_BYTES) {
      this.rejectAll(new Error(`${this.role} emitted an overlong unterminated event line`));
      this.#lineBuffer = '';
      return;
    }
    const lines = this.#lineBuffer.split('\n');
    this.#lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith(GATE1_AGENT_EVENT_PREFIX)) continue;
      let event: Gate1AgentEvent;
      try {
        event = JSON.parse(line.slice(GATE1_AGENT_EVENT_PREFIX.length)) as Gate1AgentEvent;
      } catch (error) {
        this.rejectAll(new Error(`invalid Gate 1 adapter event JSON: ${String(error)}`));
        continue;
      }
      this.#events.push(event);
      for (const pending of this.#pending) {
        if (
          event.event !== pending.expectedEvent
          || (pending.requestId !== null && event.requestId !== pending.requestId)
        ) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(pending);
        pending.resolve(event);
      }
      if (event.event === 'error' || event.event === 'boot-failed') {
        this.rejectAll(new Error(
          `${this.role} DKGAgent ${event.event} for ${event.requestId ?? 'startup'}: `
            + `${String(event.message)}`,
        ));
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function appendBounded(previous: string, chunk: string): string {
  const combined = previous + chunk;
  if (Buffer.byteLength(combined) <= MAX_CAPTURE_BYTES) return combined;
  const tail = Buffer.from(combined).subarray(-MAX_CAPTURE_BYTES).toString('utf8');
  return `[earlier output truncated]\n${tail}`;
}

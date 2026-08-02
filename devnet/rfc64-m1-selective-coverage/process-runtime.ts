import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import {
  closedRecord,
  defineRecordKeys,
  plainRecord,
} from './boundary-codec.ts';
import {
  SELECTIVE_COVERAGE_RUNTIME_PROTOCOL,
  type SelectiveCoverageEdgeRestartReceiptV1,
  type SelectiveCoverageRuntimeReadyV1,
  type SelectiveCoverageRuntimeRole,
  type SelectiveCoverageRuntimeV1,
} from './runtime.ts';
import {
  type CoreAutomaticRoundV1,
  type CoreFinalObservationV1,
  type EdgeGraphObservationV1,
  type EdgeSyncOperationV1,
  type GraphObservationV1,
} from './manifest.ts';
import type { SyncCoverageJournalReferenceV1 } from './sync-coverage-journal.ts';
import {
  decodeCoreFinalObservations,
  decodeCoreRoundResult,
  decodeEdgeObservations,
  decodeEdgeReconcilerResult,
  decodeEdgeSyncResult,
  decodeGraphObservations,
  decodeNull,
  decodeRestartReceipt,
  decodeRuntimeReady,
} from './runtime-wire.ts';

export const SELECTIVE_COVERAGE_RUNTIME_COMMAND_SCHEMA =
  'dkg-rfc64-m1-selective-coverage-runtime-command-v1' as const;
export const SELECTIVE_COVERAGE_RUNTIME_RESULT_SCHEMA =
  'dkg-rfc64-m1-selective-coverage-runtime-result-v1' as const;
export const SELECTIVE_COVERAGE_RUNTIME_RESULT_PREFIX = 'DKG_RFC64_M1_RESULT ';
const MAX_RESULT_LINE_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 5_000;

interface RuntimeSuccessResultEnvelopeV1 {
  readonly schema: typeof SELECTIVE_COVERAGE_RUNTIME_RESULT_SCHEMA;
  readonly protocol: typeof SELECTIVE_COVERAGE_RUNTIME_PROTOCOL;
  readonly sessionNonce: string;
  readonly sequence: number;
  readonly ok: true;
  readonly value: unknown;
}

interface RuntimeFailureResultEnvelopeV1 {
  readonly schema: typeof SELECTIVE_COVERAGE_RUNTIME_RESULT_SCHEMA;
  readonly protocol: typeof SELECTIVE_COVERAGE_RUNTIME_PROTOCOL;
  readonly sessionNonce: string;
  readonly sequence: number;
  readonly ok: false;
  readonly error: string;
}

const RUNTIME_SUCCESS_RESULT_KEYS = defineRecordKeys<RuntimeSuccessResultEnvelopeV1>()(
  'schema',
  'protocol',
  'sessionNonce',
  'sequence',
  'ok',
  'value',
);
const RUNTIME_FAILURE_RESULT_KEYS = defineRecordKeys<RuntimeFailureResultEnvelopeV1>()(
  'schema',
  'protocol',
  'sessionNonce',
  'sequence',
  'ok',
  'error',
);

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ProcessExitOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * JSON-lines bridge to an operator-owned adapter that controls three real DKG
 * processes. Ordinary adapter logs may use stdout; only prefixed result lines
 * are parsed as evidence-bearing responses.
 */
export class ProcessSelectiveCoverageRuntimeV1 implements SelectiveCoverageRuntimeV1 {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private sequence = 0;
  private closed = false;
  private closing = false;
  private exitError: Error | undefined;
  private stdoutBuffer = Buffer.alloc(0);
  private readonly sessionNonce = randomBytes(32).toString('hex');
  private readonly exited: Promise<ProcessExitOutcome>;
  private exitOutcome: ProcessExitOutcome | undefined;

  constructor(input: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  }) {
    if (!input.command.trim()) throw new TypeError('M1 runtime adapter command is empty');
    const timeoutMs = input.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
      throw new RangeError('M1 runtime adapter timeout is outside 1s..1h');
    }
    this.timeoutMs = timeoutMs;
    this.child = spawn(input.command, [...(input.args ?? [])], {
      cwd: input.cwd,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.pipe(process.stderr);
    this.child.stdout.on('data', (chunk: Buffer) => this.consumeChunk(chunk));
    let resolveExited!: (outcome: ProcessExitOutcome) => void;
    this.exited = new Promise((resolveExit) => {
      resolveExited = resolveExit;
    });
    let terminal = false;
    const resolveTerminal = (outcome: ProcessExitOutcome) => {
      if (terminal) return;
      terminal = true;
      this.exitOutcome = outcome;
      resolveExited(outcome);
    };
    this.child.on('error', (error) => {
      // Spawn failures are terminal but ChildProcess also emits `error` for
      // failures such as an unsuccessful kill while the child is still live.
      // Do not let those later errors falsely satisfy cleanup.
      if (this.child.pid === undefined
        || this.child.exitCode !== null
        || this.child.signalCode !== null) {
        resolveTerminal({ code: this.child.exitCode, signal: this.child.signalCode });
      }
      this.failAll(new Error('M1 runtime adapter process failed', { cause: error }));
    });
    this.child.once('exit', (code, signal) => {
      resolveTerminal({ code, signal });
      if (!this.closing || this.pending.size > 0) {
        this.failAll(new Error(
          `M1 runtime adapter exited before shutdown acknowledgement `
            + `(code=${String(code)} signal=${String(signal)})`,
        ));
      }
    });
    this.child.once('close', (code, signal) => {
      resolveTerminal({ code, signal });
      if (!this.closing || this.pending.size > 0) {
        this.failAll(new Error(
          `M1 runtime adapter closed before shutdown acknowledgement `
            + `(code=${String(code)} signal=${String(signal)})`,
        ));
      }
    });
  }

  private readonly timeoutMs: number;

  async start(role: SelectiveCoverageRuntimeRole): Promise<SelectiveCoverageRuntimeReadyV1> {
    return await this.request('start', { role }, decodeRuntimeReady);
  }

  async stop(role: SelectiveCoverageRuntimeRole): Promise<void> {
    await this.request('stop', { role }, decodeNull);
  }

  async publishWave(wave: 'selected' | 'final'): Promise<readonly GraphObservationV1[]> {
    return await this.request('publish-wave', { wave }, decodeGraphObservations);
  }

  async observeEdge(
    checkpoint: 'before-selection' | 'after-selection' | 'after-restart'
      | 'after-second-on-demand',
  ): Promise<readonly EdgeGraphObservationV1[]> {
    return await this.request('observe-edge', { checkpoint }, decodeEdgeObservations);
  }

  async synchronizeEdge(input: {
    readonly contextGraphId: string;
    readonly phase: 'selection' | 'post-restart-explicit';
    readonly syncMode: 'always-on' | 'on-demand';
    readonly wave: EdgeSyncOperationV1['completedWave'];
  }): Promise<{
    readonly operation: Omit<EdgeSyncOperationV1, 'sequence'>;
    readonly journal?: SyncCoverageJournalReferenceV1;
  }> {
    return await this.request('synchronize-edge', input, decodeEdgeSyncResult);
  }

  async restartEdge(): Promise<SelectiveCoverageEdgeRestartReceiptV1> {
    return await this.request('restart-edge', {}, decodeRestartReceipt);
  }

  async waitForEdgeReconciler(input: {
    readonly contextGraphId: string;
  }): Promise<{
    readonly operation: Omit<EdgeSyncOperationV1, 'sequence'>;
    readonly journal: SyncCoverageJournalReferenceV1;
  }> {
    return await this.request('wait-edge-reconciler', input, decodeEdgeReconcilerResult);
  }

  async runCoreAutomaticRound(round: number): Promise<{
    readonly round: CoreAutomaticRoundV1;
    readonly journal: SyncCoverageJournalReferenceV1;
  }> {
    return await this.request('core-automatic-round', { round }, decodeCoreRoundResult);
  }

  async observeCoreFinal(): Promise<readonly CoreFinalObservationV1[]> {
    return await this.request('observe-core-final', {}, decodeCoreFinalObservations);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    let shutdownFailure: unknown;
    try {
      await this.request('shutdown', {}, decodeNull);
    } catch (error) {
      shutdownFailure = error;
    }
    this.closed = true;
    this.child.stdin.end();
    let forcedSignal: NodeJS.Signals | undefined;
    let exit = await this.waitForExit(CLOSE_GRACE_MS);
    if (!exit) {
      forcedSignal = 'SIGTERM';
      this.child.kill('SIGTERM');
      exit = await this.waitForExit(CLOSE_GRACE_MS);
      if (!exit) {
        forcedSignal = 'SIGKILL';
        this.child.kill('SIGKILL');
        exit = await this.waitForExit(CLOSE_GRACE_MS);
      }
    }
    if (shutdownFailure !== undefined) throw shutdownFailure;
    if (this.exitError) throw this.exitError;
    if (!exit) {
      throw new Error('M1 runtime adapter did not exit after forced SIGKILL');
    }
    if (forcedSignal) {
      throw new Error(`M1 runtime adapter required forced ${forcedSignal} during shutdown`);
    }
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `M1 runtime adapter exited abnormally after shutdown `
          + `(code=${String(exit.code)} signal=${String(exit.signal)})`,
      );
    }
  }

  private request<T>(
    command: string,
    payload: unknown,
    decode: (input: unknown) => T,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('M1 runtime adapter is closed'));
    if (this.exitError) return Promise.reject(this.exitError);
    const sequence = this.sequence;
    this.sequence += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sequence);
        reject(new Error(`M1 runtime adapter command timed out: ${command}`));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(sequence, {
        resolve: (value) => {
          try {
            resolve(decode(value));
          } catch (error) {
            reject(new Error(`M1 runtime adapter response failed decoding: ${command}`, {
              cause: error,
            }));
          }
        },
        reject,
        timer,
      });
      const envelope = JSON.stringify({
        schema: SELECTIVE_COVERAGE_RUNTIME_COMMAND_SCHEMA,
        protocol: SELECTIVE_COVERAGE_RUNTIME_PROTOCOL,
        sessionNonce: this.sessionNonce,
        sequence,
        command,
        payload,
      });
      this.child.stdin.write(`${envelope}\n`, (error) => {
        if (!error) return;
        const request = this.pending.get(sequence);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(sequence);
        request.reject(new Error(`M1 runtime adapter command write failed: ${command}`, {
          cause: error,
        }));
      });
    });
  }

  private consumeChunk(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    let newline = this.stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.byteLength > MAX_RESULT_LINE_BYTES) {
        this.failAll(new Error('M1 runtime adapter result/log line exceeds 1 MiB'));
        return;
      }
      this.consumeLine(line.toString('utf8').replace(/\r$/u, ''));
      newline = this.stdoutBuffer.indexOf(0x0a);
    }
    if (this.stdoutBuffer.byteLength > MAX_RESULT_LINE_BYTES) {
      this.failAll(new Error('M1 runtime adapter result/log line exceeds 1 MiB'));
    }
  }

  private consumeLine(line: string): void {
    if (!line.startsWith(SELECTIVE_COVERAGE_RUNTIME_RESULT_PREFIX)) return;
    let value: unknown;
    try {
      value = JSON.parse(line.slice(SELECTIVE_COVERAGE_RUNTIME_RESULT_PREFIX.length));
    } catch (error) {
      this.failAll(new Error('M1 runtime adapter emitted malformed result JSON', { cause: error }));
      return;
    }
    const probe = plainRecord(value);
    const row = probe?.['ok'] === true
      ? closedRecord(value, RUNTIME_SUCCESS_RESULT_KEYS)
      : probe?.['ok'] === false
        ? closedRecord(value, RUNTIME_FAILURE_RESULT_KEYS)
        : undefined;
    if (!row
      || row['schema'] !== SELECTIVE_COVERAGE_RUNTIME_RESULT_SCHEMA
      || row['protocol'] !== SELECTIVE_COVERAGE_RUNTIME_PROTOCOL
      || row['sessionNonce'] !== this.sessionNonce
      || !Number.isSafeInteger(row['sequence'])
      || (row['ok'] === false && (typeof row['error'] !== 'string' || !row['error']))) {
      this.failAll(new Error('M1 runtime adapter emitted an invalid result envelope'));
      return;
    }
    const sequence = row['sequence'] as number;
    const request = this.pending.get(sequence);
    if (!request) {
      this.failAll(new Error(`M1 runtime adapter emitted an unknown result sequence: ${sequence}`));
      return;
    }
    clearTimeout(request.timer);
    this.pending.delete(sequence);
    if (row['ok'] === true) {
      request.resolve(row['value']);
      return;
    }
    request.reject(new Error(row['error'] as string));
  }

  private failAll(error: Error): void {
    if (!this.exitError) this.exitError = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private async waitForExit(timeoutMs: number): Promise<ProcessExitOutcome | undefined> {
    if (this.exitOutcome) return this.exitOutcome;
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return { code: this.child.exitCode, signal: this.child.signalCode };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<undefined>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(undefined), timeoutMs);
      timer.unref();
    });
    const result = await Promise.race([this.exited, timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  }
}

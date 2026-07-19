import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  ChildProcessRegistry,
  cleanupPreservingPrimaryFailure,
  terminateBeforeRejecting,
  type ManagedChildProcess,
} from './process-lifecycle.js';

class FakeChild extends EventEmitter implements ManagedChildProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly deliveredSignals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.deliveredSignals.push(signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }
}

test('timeout rejection waits for child close and preserves the primary failure', async () => {
  const registry = new ChildProcessRegistry();
  const child = new FakeChild();
  const tracked = registry.track(child);
  const primary = new Error('ready timeout');
  let settled = false;
  const rejection = terminateBeforeRejecting(
    registry,
    tracked,
    primary,
    () => assert.fail('termination should not fail'),
  ).finally(() => { settled = true; });

  await Promise.resolve();
  assert.deepEqual(child.deliveredSignals, ['SIGKILL']);
  assert.equal(settled, false);
  child.close(null, 'SIGKILL');
  await assert.rejects(rejection, (error) => error === primary);
});

test('registry terminates every active child and waits for every close', async () => {
  const registry = new ChildProcessRegistry();
  const first = new FakeChild();
  const second = new FakeChild();
  registry.track(first);
  registry.track(second);
  let settled = false;
  const cleanup = registry.terminateAllAndWait().finally(() => { settled = true; });

  await Promise.resolve();
  assert.deepEqual(first.deliveredSignals, ['SIGKILL']);
  assert.deepEqual(second.deliveredSignals, ['SIGKILL']);
  first.close(null, 'SIGKILL');
  await Promise.resolve();
  assert.equal(settled, false);
  second.close(null, 'SIGKILL');
  await cleanup;
  assert.equal(settled, true);
});

test('final cleanup reports its failure without replacing the operation failure', async () => {
  const primary = new Error('primary harness failure');
  const cleanup = new Error('secondary cleanup failure');
  const reports: Array<readonly [unknown, unknown]> = [];

  await assert.rejects(
    cleanupPreservingPrimaryFailure({
      operationFailed: true,
      primaryFailure: primary,
      cleanup: async () => { throw cleanup; },
      reportSecondaryFailure: (first, second) => reports.push([first, second]),
    }),
    (error) => error === primary,
  );
  assert.deepEqual(reports, [[primary, cleanup]]);
});

test('final cleanup failure remains fatal after a successful operation', async () => {
  const cleanup = new Error('cleanup failure');
  await assert.rejects(
    cleanupPreservingPrimaryFailure({
      operationFailed: false,
      primaryFailure: undefined,
      cleanup: async () => { throw cleanup; },
      reportSecondaryFailure: () => assert.fail('there is no primary failure'),
    }),
    (error) => error === cleanup,
  );
});

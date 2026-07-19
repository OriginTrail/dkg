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

  constructor(readonly killResult = true) {
    super();
  }

  kill(signal: NodeJS.Signals): boolean {
    this.deliveredSignals.push(signal);
    return this.killResult;
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

test('ordered cleanup waits for every child close before removing data', async () => {
  const registry = new ChildProcessRegistry();
  const first = new FakeChild();
  const second = new FakeChild();
  registry.track(first);
  registry.track(second);
  let settled = false;
  let dataRemoved = false;
  const cleanup = registry.terminateAllThenCleanup(() => {
    dataRemoved = true;
  }).finally(() => { settled = true; });

  await Promise.resolve();
  assert.deepEqual(first.deliveredSignals, ['SIGKILL']);
  assert.deepEqual(second.deliveredSignals, ['SIGKILL']);
  first.close(null, 'SIGKILL');
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(dataRemoved, false);
  second.close(null, 'SIGKILL');
  await cleanup;
  assert.equal(settled, true);
  assert.equal(dataRemoved, true);
});

test('post-SIGKILL close deadline is bounded and prevents data removal', async () => {
  const registry = new ChildProcessRegistry(10);
  const child = new FakeChild();
  const tracked = registry.track(child);
  let dataRemoved = false;

  await assert.rejects(
    registry.terminateAndWait(tracked),
    /did not emit close within 10ms after SIGKILL/,
  );
  assert.deepEqual(child.deliveredSignals, ['SIGKILL']);

  await assert.rejects(
    registry.terminateAllThenCleanup(() => { dataRemoved = true; }),
    /did not emit close within 10ms after SIGKILL/,
  );
  assert.equal(dataRemoved, false);
});

test('ordered cleanup aggregates termination and data-removal failures after close', async () => {
  const registry = new ChildProcessRegistry();
  const child = new FakeChild(false);
  registry.track(child);
  const removalFailure = new Error('data removal failed');
  let dataRemovalAttempted = false;
  const cleanup = registry.terminateAllThenCleanup(() => {
    dataRemovalAttempted = true;
    throw removalFailure;
  });

  await Promise.resolve();
  child.close(null, 'SIGKILL');
  await assert.rejects(cleanup, (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(String(error.errors[0]), /failed to deliver SIGKILL/);
    assert.equal(error.errors[1], removalFailure);
    return true;
  });
  assert.equal(dataRemovalAttempted, true);
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

test('reporter exceptions never replace the primary failure', async () => {
  const primary = new Error('primary failure');
  const registry = new ChildProcessRegistry();
  const child = new FakeChild(false);
  const tracked = registry.track(child);
  const termination = terminateBeforeRejecting(
    registry,
    tracked,
    primary,
    () => { throw new Error('reporter failed'); },
  );

  await Promise.resolve();
  child.close(null, 'SIGKILL');
  await assert.rejects(termination, (error) => error === primary);

  await assert.rejects(
    cleanupPreservingPrimaryFailure({
      operationFailed: true,
      primaryFailure: primary,
      cleanup: async () => { throw new Error('cleanup failed'); },
      reportSecondaryFailure: () => { throw new Error('reporter failed'); },
    }),
    (error) => error === primary,
  );
});

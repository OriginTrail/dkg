import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { WasmStrategyAdmissionClient } from '../src/admission.js';
import {
  ComponentOperationError,
  ComponentOverloadError,
  ComponentUnavailableError,
} from '../src/component-supervisor.js';
import { SemanticRuntimeHost } from '../src/host.js';
import { defaultExecutionCapability } from '../src/component-types.js';

const workerUrl = new URL('../dist/worker.js', import.meta.url);
const componentWorkerUrl = new URL('../dist/component-worker.js', import.meta.url);
const source = `(strategy smoke/concurrent-component
  (version "1.0.0")
  (scope network:devnet)
  (goal isolated-component-stores)
  (supervise one-for-one (max-restarts 1) (window-ms 1000)
    (delegate worker (emit component-ok))))`;

async function plan(): Promise<Uint8Array> {
  const admission = new WasmStrategyAdmissionClient({ workerUrl: componentWorkerUrl });
  const compiled = await admission.compileAndAdmit(source);
  if (!compiled.ok) throw new Error('component concurrency fixture did not compile');
  return compiled.plan.canonicalPlan;
}

describe('WASI 0.3 component execution isolation', () => {
  it('completes another real component while the first is suspended in a host tool', async () => {
    const admission = new WasmStrategyAdmissionClient({ workerUrl: componentWorkerUrl });
    const slow = await admission.compileAndAdmit(`(strategy smoke/suspended
      (version "1.0.0") (scope network:devnet) (goal overlap)
      (supervise one-for-one (max-restarts 1) (window-ms 1000)
        (delegate reader (grant dkg.query) (call dkg/query@1 "barrier"))))`);
    if (!slow.ok) throw new Error('suspended fixture did not compile');
    const fast = await plan();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const capability = defaultExecutionCapability(createHash('sha256').update('DKG-STRATEGY-PLAN-V1\0').update(slow.plan.canonicalPlan).digest('hex'));
    capability.tools = [{ operation: 'dkg/query', version: '1', witInterface: 'origintrail:semantic-runtime/query-catalog@0.1.0' }];
    capability.budgets.maxToolCalls = capability.budgets.maxDkgQueries = 1;
    const host = new SemanticRuntimeHost({ workerUrl, componentWorkerUrl, config: { watchdogMs: 1000, maxActiveExecutions: 2 } });
    await host.start();
    let firstRun: Promise<unknown> | undefined;
    try {
      const first = await host.startPlan(slow.plan.canonicalPlan, 0n, capability, async () => {
        entered.resolve(); await release.promise;
        return { kind: 'query-catalog', json: '[]' };
      });
      let firstFinished = false;
      firstRun = host.applyPlan(first.handle).then(result => { firstFinished = true; return result; });
      await entered.promise;
      const second = await host.startPlan(fast);
      await expect(host.applyPlan(second.handle)).resolves.toMatchObject({ kind: 'completed' });
      expect(firstFinished).toBe(false);
      await host.dropPlan(second.handle);
      expect(host.activeComponentExecutions).toBe(1);
      release.resolve();
      await expect(firstRun).resolves.toMatchObject({ kind: 'completed' });
      await host.dropPlan(first.handle);
      expect(host.activeComponentExecutions).toBe(0);
    } finally {
      release.resolve();
      await host.stop();
      await firstRun?.catch(() => undefined);
    }
  });

  it('runs independent executions in distinct component instances without a global queue', async () => {
    const canonicalPlan = await plan();
    const host = new SemanticRuntimeHost({
      workerUrl,
      componentWorkerUrl,
      config: { watchdogMs: 1_000, maxActiveExecutions: 2 },
    });
    await host.start();
    try {
      const [first, second] = await Promise.all([
        host.startPlan(canonicalPlan),
        host.startPlan(canonicalPlan),
      ]);
      expect(first.componentInstanceId).toBeTruthy();
      expect(second.componentInstanceId).toBeTruthy();
      expect(first.componentInstanceId).not.toBe(second.componentInstanceId);
      expect(host.activeComponentExecutions).toBe(2);

      const [firstStep, secondStep] = await Promise.all([
        host.applyPlan(first.handle),
        host.applyPlan(second.handle),
      ]);
      expect(firstStep).toMatchObject({ kind: 'completed' });
      expect(secondStep).toMatchObject({ kind: 'completed' });
      await Promise.all([host.dropPlan(first.handle), host.dropPlan(second.handle)]);
      expect(host.activeComponentExecutions).toBe(0);
    } finally {
      await host.stop();
    }
  });

  it('rejects overload instead of creating unbounded component Workers', async () => {
    const canonicalPlan = await plan();
    const host = new SemanticRuntimeHost({
      workerUrl,
      componentWorkerUrl,
      config: { watchdogMs: 1_000, maxActiveExecutions: 1 },
    });
    await host.start();
    try {
      const results = await Promise.allSettled([
        host.startPlan(canonicalPlan),
        host.startPlan(canonicalPlan),
      ]);
      const started = results.find((result) => result.status === 'fulfilled');
      const rejected = results.find((result) => result.status === 'rejected');
      expect(started?.status).toBe('fulfilled');
      expect(rejected?.status).toBe('rejected');
      if (rejected?.status === 'rejected') {
        expect(rejected.reason).toBeInstanceOf(ComponentOverloadError);
      }
      if (started?.status === 'fulfilled') await host.dropPlan(started.value.handle);
    } finally {
      await host.stop();
    }
  });

  it('destroys only the execution partition with an injected Worker trap', async () => {
    const canonicalPlan = await plan();
    const host = new SemanticRuntimeHost({
      workerUrl,
      componentWorkerUrl,
      allowTestOperations: true,
      config: { watchdogMs: 1_000, maxActiveExecutions: 2 },
    });
    await host.start();
    try {
      const first = await host.startPlan(canonicalPlan);
      const second = await host.startPlan(canonicalPlan);
      await expect(host.componentTestTrap(first.handle)).rejects.toBeInstanceOf(
        ComponentUnavailableError,
      );
      await expect(host.applyPlan(second.handle)).resolves.toMatchObject({ kind: 'completed' });
      await Promise.all([host.dropPlan(first.handle), host.dropPlan(second.handle)]);
    } finally {
      await host.stop();
    }
  });

  it('interrupts an execution partition with an injected Worker hang without stopping another execution', async () => {
    const canonicalPlan = await plan();
    const host = new SemanticRuntimeHost({
      workerUrl,
      componentWorkerUrl,
      allowTestOperations: true,
      config: { watchdogMs: 50, maxActiveExecutions: 2 },
    });
    await host.start();
    try {
      const first = await host.startPlan(canonicalPlan);
      const second = await host.startPlan(canonicalPlan);
      await expect(host.componentTestHang(first.handle)).rejects.toMatchObject({
        name: 'ComponentRequestTimeoutError',
        operation: 'test_hang',
      });
      await expect(host.applyPlan(second.handle)).resolves.toMatchObject({ kind: 'completed' });
      await Promise.all([host.dropPlan(first.handle), host.dropPlan(second.handle)]);
    } finally {
      await host.stop();
    }
  });

  it('enforces an execution-scoped operation budget', async () => {
    const canonicalPlan = await plan();
    const host = new SemanticRuntimeHost({
      workerUrl,
      componentWorkerUrl,
      config: { watchdogMs: 1_000, maxOperationsPerExecution: 1 },
    });
    await host.start();
    try {
      const started = await host.startPlan(canonicalPlan);
      await expect(host.applyPlan(started.handle)).resolves.toMatchObject({ kind: 'completed' });
      await expect(host.applyPlan(started.handle)).rejects.toMatchObject<Partial<ComponentOperationError>>({
        code: 'COMPONENT_OPERATION_BUDGET_EXHAUSTED',
        category: 'limit',
      });
      await host.dropPlan(started.handle);
    } finally {
      await host.stop();
    }
  });
});

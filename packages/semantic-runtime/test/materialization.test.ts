import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WasmStrategyAdmissionClient } from '../src/admission.js';
import { defaultExecutionCapability } from '../src/component-types.js';
import { SemanticRuntimeHost } from '../src/host.js';

const workerUrl = new URL('../dist/worker.js', import.meta.url);
const componentWorkerUrl = new URL('../dist/component-worker.js', import.meta.url);
const sourcePath = fileURLToPath(new URL('../smoke/two-agents.scm', import.meta.url));

describe('real Wasm supervised-plan materialization', () => {
  it('compiles, re-admits, starts, and inspects two logical agents without mocks', async () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const admission = new WasmStrategyAdmissionClient({ workerUrl: componentWorkerUrl });
    const compilation = await admission.compileAndAdmit(source);
    expect(compilation.ok).toBe(true);
    if (!compilation.ok) return;

    const host = new SemanticRuntimeHost({ workerUrl, componentWorkerUrl, config: { watchdogMs: 1_000 } });
    await host.start();
    try {
      const started = await host.startPlan(compilation.plan.canonicalPlan, 0n);
      expect(Buffer.from(started.canonicalHash).equals(Buffer.from(compilation.plan.canonicalHash)))
        .toBe(true);
      expect(started.strategyRef).toBe('smoke/two-agents@1.0.0');
      expect(started.agents.map((agent) => agent.role)).toEqual([
        'observer-alpha',
        'observer-beta',
      ]);
      expect(started.agents.map((agent) => agent.status)).toEqual(['runnable', 'runnable']);
      expect(new Set(started.agents.map((agent) => Buffer.from(agent.processId).toString('hex'))).size)
        .toBe(2);

      const executed = await host.applyPlan(started.handle);
      expect(executed).toMatchObject({
        kind: 'completed',
        events: [
          { role: 'observer-alpha', value: 's:alpha-started' },
          { role: 'observer-beta', value: 's:beta-started' },
        ],
        outputs: [],
      });
      const inspected = await host.inspectPlan(started.handle);
      expect(inspected.agents.map((agent) => agent.status)).toEqual(['terminated', 'terminated']);
    } finally {
      await host.stop();
    }
  });

  it('lets Wasm invoke the explicit investigator import', async () => {
    const source = `(strategy smoke/llm
      (version "1.0.0")
      (scope network:devnet)
      (goal prove-llm-resume)
      (supervise one-for-one (max-restarts 2) (window-ms 60000)
        (delegate investigator
          (grant agent.invoke.investigator)
          (emit llm-started)
          (call agent/investigate@1 "Say hello")
          (emit llm-finished))))`;
    const admission = new WasmStrategyAdmissionClient({ workerUrl: componentWorkerUrl });
    const compilation = await admission.compileAndAdmit(source);
    expect(compilation.ok).toBe(true);
    if (!compilation.ok) return;

    const host = new SemanticRuntimeHost({ workerUrl, componentWorkerUrl, config: { watchdogMs: 1_000 } });
    await host.start();
    try {
      const unauthorizedDispatcher = async () => ({
        kind: 'investigator' as const,
        output: 'must-not-run',
      });
      const unauthorized = await host.startPlan(
        compilation.plan.canonicalPlan,
        0n,
        undefined,
        unauthorizedDispatcher,
      );
      await expect(host.applyPlan(unauthorized.handle)).rejects.toMatchObject({
        code: 'COMPONENT_TOOL_NOT_AUTHORIZED',
        category: 'tool',
      });
      await host.dropPlan(unauthorized.handle);

      const capability = toolCapability(compilation.plan.canonicalPlan, {
        operation: 'agent/investigate',
        witInterface: 'origintrail:semantic-runtime/investigator@0.1.0',
      });
      const started = await host.startPlan(
        compilation.plan.canonicalPlan,
        0n,
        capability,
        async (call) => {
          expect(call).toEqual({
            kind: 'investigator',
            effectId: 1n,
            prompt: 'Say hello',
          });
          return { kind: 'investigator', output: 'Hello from the model' };
        },
      );
      const completed = await host.applyPlan(started.handle);
      expect(completed).toMatchObject({
        kind: 'completed',
        events: [
          { role: 'investigator', value: 's:llm-started' },
          { role: 'investigator', value: 's:llm-finished' },
        ],
        outputs: [{ role: 'investigator', value: 'Hello from the model' }],
      });
    } finally {
      await host.stop();
    }
  });

  it('lets Wasm invoke the explicit query-catalog import', async () => {
    const source = `(strategy smoke/query
      (version "1.0.0")
      (scope network:devnet)
      (goal prove-dkg-query-resume)
      (supervise one-for-one (max-restarts 2) (window-ms 60000)
        (delegate reader
          (grant dkg.query)
          (call dkg/query@1 "configuration-trace"))))`;
    const admission = new WasmStrategyAdmissionClient({ workerUrl: componentWorkerUrl });
    const compilation = await admission.compileAndAdmit(source);
    expect(compilation.ok).toBe(true);
    if (!compilation.ok) return;

    const host = new SemanticRuntimeHost({ workerUrl, componentWorkerUrl, config: { watchdogMs: 1_000 } });
    await host.start();
    try {
      const output = '{"queryIri":"urn:query:configuration-trace","result":{"bindings":[],"type":"bindings"}}';
      const capability = toolCapability(compilation.plan.canonicalPlan, {
        operation: 'dkg/query',
        witInterface: 'origintrail:semantic-runtime/query-catalog@0.1.0',
      });
      const started = await host.startPlan(
        compilation.plan.canonicalPlan,
        0n,
        capability,
        async (call) => {
          expect(call).toEqual({
            kind: 'query-catalog',
            effectId: 1n,
            queryId: 'configuration-trace',
            parameters: [],
          });
          return { kind: 'query-catalog', json: output };
        },
      );
      const completed = await host.applyPlan(started.handle);
      expect(completed).toMatchObject({
        kind: 'completed',
        outputs: [{ role: 'reader', value: output }],
      });
    } finally {
      await host.stop();
    }
  });

  it('lets Wasm invoke only the typed safe-llm import', async () => {
    const source = `(strategy smoke/safe-llm
      (version "1.0.0")
      (scope network:devnet)
      (goal use-permitted-programs)
      (supervise one-for-one (max-restarts 1) (window-ms 60000)
        (delegate assistant
          (grant llm.invoke.safe)
          (call llm/safe@1 "Answer using the available Programs"))))`;
    const admission = new WasmStrategyAdmissionClient({ workerUrl: componentWorkerUrl });
    const compilation = await admission.compileAndAdmit(source);
    expect(compilation.ok).toBe(true);
    if (!compilation.ok) return;
    const host = new SemanticRuntimeHost({ workerUrl, componentWorkerUrl, config: { watchdogMs: 1_000 } });
    await host.start();
    try {
      const capability = toolCapability(compilation.plan.canonicalPlan, {
        operation: 'llm/safe',
        witInterface: 'origintrail:semantic-runtime/safe-llm@0.1.0',
      });
      const started = await host.startPlan(
        compilation.plan.canonicalPlan,
        0n,
        capability,
        async (call) => {
          expect(call).toEqual({
            kind: 'safe-llm',
            effectId: 1n,
            prompt: 'Answer using the available Programs',
          });
          return { kind: 'safe-llm', output: 'safe answer' };
        },
      );
      await expect(host.applyPlan(started.handle)).resolves.toMatchObject({
        kind: 'completed',
        outputs: [{ role: 'assistant', value: 'safe answer' }],
      });
    } finally {
      await host.stop();
    }
  });

  it('lets Wasm invoke only the explicit typed remote-execute import', async () => {
    const source = `(strategy smoke/composition
      (version "1.0.0")
      (scope network:devnet)
      (goal execute-child-on-peer-b)
      (supervise one-for-one (max-restarts 1) (window-ms 60000)
        (delegate composer
          (grant program.remote-execute)
          (call remote-execute@1 "12D3KooWPeerB" "urn:sr:program:child"))))`;
    const admission = new WasmStrategyAdmissionClient({ workerUrl: componentWorkerUrl });
    const compilation = await admission.compileAndAdmit(source);
    expect(compilation.ok).toBe(true);
    if (!compilation.ok) return;

    const host = new SemanticRuntimeHost({ workerUrl, componentWorkerUrl, config: { watchdogMs: 1_000 } });
    await host.start();
    try {
      const capability = toolCapability(compilation.plan.canonicalPlan, {
        operation: 'remote-execute',
        witInterface: 'origintrail:semantic-runtime/remote-execute@0.1.0',
      });
      const started = await host.startPlan(
        compilation.plan.canonicalPlan,
        0n,
        capability,
        async (call) => {
          expect(call).toEqual({
            kind: 'remote-execute',
            effectId: 1n,
            nodeId: '12D3KooWPeerB',
            programIri: 'urn:sr:program:child',
          });
          return {
            kind: 'remote-execute',
            executionIri: 'urn:sr:execution:child',
            executionUal: 'did:dkg:31337/0x2222222222222222222222222222222222222222/7',
          };
        },
      );
      await expect(host.applyPlan(started.handle)).resolves.toMatchObject({
        kind: 'completed',
        outputs: [{ role: 'composer', value: 'urn:sr:execution:child' }],
      });
    } finally {
      await host.stop();
    }
  });
});

function toolCapability(
  plan: Uint8Array,
  tool: { operation: string; witInterface: string },
) {
  const planHash = createHash('sha256')
    .update('DKG-STRATEGY-PLAN-V1\0')
    .update(plan)
    .digest('hex');
  const capability = defaultExecutionCapability(planHash);
  capability.tools = [{ operation: tool.operation, version: '1', witInterface: tool.witInterface }];
  capability.budgets.maxToolCalls = 1;
  capability.budgets.maxModelTokens = ['agent/investigate', 'llm/safe'].includes(tool.operation)
    ? 512
    : 0;
  capability.budgets.maxDkgQueries = tool.operation === 'dkg/query' ? 1 : 0;
  return capability;
}

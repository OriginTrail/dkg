import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WasmStrategyAdmissionClient } from '../src/admission.js';
import { SemanticRuntimeHost } from '../src/host.js';

const workerUrl = new URL('../dist/worker.js', import.meta.url);
const sourcePath = fileURLToPath(new URL('../smoke/two-agents.scm', import.meta.url));

describe('real Wasm supervised-plan materialization', () => {
  it('compiles, re-admits, starts, and inspects two logical agents without mocks', async () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const admission = new WasmStrategyAdmissionClient({ workerUrl });
    const compilation = await admission.compileAndAdmit(source);
    expect(compilation.ok).toBe(true);
    if (!compilation.ok) return;

    const host = new SemanticRuntimeHost({ workerUrl, config: { watchdogMs: 1_000 } });
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

  it('lets Wasm request and resume one investigator model call', async () => {
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
    const admission = new WasmStrategyAdmissionClient({ workerUrl });
    const compilation = await admission.compileAndAdmit(source);
    expect(compilation.ok).toBe(true);
    if (!compilation.ok) return;

    const host = new SemanticRuntimeHost({ workerUrl, config: { watchdogMs: 1_000 } });
    await host.start();
    try {
      const started = await host.startPlan(compilation.plan.canonicalPlan);
      const requested = await host.applyPlan(started.handle);
      expect(requested).toMatchObject({
        kind: 'effect-requested',
        operation: 'agent/investigate',
        version: 1,
        arguments: ['t:Say hello'],
      });
      if (requested.kind !== 'effect-requested') return;
      const completed = await host.applyPlan(started.handle, {
        effectId: requested.effectId,
        ok: true,
        value: 'Hello from the model',
      });
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

  it('lets Wasm request and resume one catalog-backed DKG query', async () => {
    const source = `(strategy smoke/query
      (version "1.0.0")
      (scope network:devnet)
      (goal prove-dkg-query-resume)
      (supervise one-for-one (max-restarts 2) (window-ms 60000)
        (delegate reader
          (grant dkg.query)
          (call dkg/query@1 "configuration-trace"))))`;
    const admission = new WasmStrategyAdmissionClient({ workerUrl });
    const compilation = await admission.compileAndAdmit(source);
    expect(compilation.ok).toBe(true);
    if (!compilation.ok) return;

    const host = new SemanticRuntimeHost({ workerUrl, config: { watchdogMs: 1_000 } });
    await host.start();
    try {
      const started = await host.startPlan(compilation.plan.canonicalPlan);
      const requested = await host.applyPlan(started.handle);
      expect(requested).toMatchObject({
        kind: 'effect-requested',
        operation: 'dkg/query',
        version: 1,
        arguments: ['t:configuration-trace'],
      });
      if (requested.kind !== 'effect-requested') return;
      const output = '{"queryIri":"urn:query:configuration-trace","result":{"bindings":[],"type":"bindings"}}';
      const completed = await host.applyPlan(started.handle, {
        effectId: requested.effectId,
        ok: true,
        value: output,
      });
      expect(completed).toMatchObject({
        kind: 'completed',
        outputs: [{ role: 'reader', value: output }],
      });
    } finally {
      await host.stop();
    }
  });
});

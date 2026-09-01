import { describe, expect, it } from 'vitest';

import {
  AbiResponseError,
  WasmStrategyAdmissionClient,
} from '../src/index.js';

const workerUrl = new URL('../dist/worker.js', import.meta.url);

const listenerBoy = `
  (strategy sre/keep-network-healthy
    (version "0.4.0")
    (scope network:testnet)
    (goal p95-latency-below-500ms)
    (sequence
      (observe logs/read@1 affected-nodes 50m)
      (approve infrastructure-change)
      (delegate remediation-worker
        (grant infra.node.drain)
        (call infra/drain-node@1 node-17))))
`;

describe('WasmStrategyAdmissionClient', () => {
  it('compiles in a disposable Worker and re-admits the canonical plan in a fresh Worker', async () => {
    const client = new WasmStrategyAdmissionClient({ workerUrl });
    const result = await client.compileAndAdmit(listenerBoy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.strategyRef).toBe('sre/keep-network-healthy@0.4.0');
    expect(result.plan.requiredCapabilities).toEqual(['infra.node.drain', 'logs.read']);
    expect(result.plan.effectUpperBound).toEqual(['read', 'infrastructure-change']);
    expect(result.plan.approvalRequirements).toEqual(['infrastructure-change']);
    expect(result.plan.canonicalHash).toHaveLength(32);
  });

  it('returns source-spanned stable diagnostics without evaluating unknown forms', async () => {
    const client = new WasmStrategyAdmissionClient({ workerUrl });
    const result = await client.compileStrategy(`
      (strategy unsafe (version "1.0.0") (scope network:testnet) (goal unsafe)
        (eval "(call infra/drain-node@1 node-17)"))
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({ code: 'IR_UNKNOWN_FORM' });
    expect(result.diagnostics[0]?.primary.start.line).toBeGreaterThan(0);
  });

  it('rejects an investigator call with more than one prompt argument', async () => {
    const client = new WasmStrategyAdmissionClient({ workerUrl });
    const result = await client.compileStrategy(`
      (strategy invalid-llm-arguments
        (version "1.0.0")
        (scope network:testnet)
        (goal reject-ignored-arguments)
        (delegate investigator
          (grant agent.invoke.investigator)
          (call agent/investigate@1 "Say hi" "ignored")))
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({ code: 'IR_SCHEMA_MISMATCH' });
  });

  it('rejects canonical bytes whose declared authority no longer matches the plan tree', async () => {
    const client = new WasmStrategyAdmissionClient({ workerUrl });
    const compiled = await client.compileStrategy(listenerBoy);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const forged = Uint8Array.from(compiled.plan.canonicalPlan);
    const original = new TextEncoder().encode('logs.read');
    const replacement = new TextEncoder().encode('logs.evil');
    const offset = findBytes(forged, original);
    expect(offset).toBeGreaterThanOrEqual(0);
    forged.set(replacement, offset);
    await expect(client.admitPlan(forged)).rejects.toMatchObject<Partial<AbiResponseError>>({
      code: 'PLAN_ANALYSIS_MISMATCH',
      category: 'admission',
    });
  });
});

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    if (needle.every((value, index) => haystack[offset + index] === value)) return offset;
  }
  return -1;
}

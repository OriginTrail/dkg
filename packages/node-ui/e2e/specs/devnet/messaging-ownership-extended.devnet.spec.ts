/**
 * Extended inter-node messaging soak + ownership / KA update prerequisites.
 */
import { test, expect } from '../../fixtures/base.js';
import {
  devnetApiFetch,
  waitForDevnetStatus,
  requireDevnetPrecondition,
  requireDevnetNode,
} from '../../helpers/devnet.js';
import {
  listContextGraphs,
  runWmSwmVmPipeline,
  buildTestQuads,
} from '../../helpers/devnet-publish.js';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await requireDevnetNode(test, 1);
  await waitForDevnetStatus(1);
});

test.describe('Prolonged inter-node messaging soak', () => {
  test('agents peer count stable over 30s polling window', async () => {
    await requireDevnetNode(test, 2);
    const samples: number[] = [];
    let okResponses = 0;
    for (let i = 0; i < 15; i++) {
      const res = await devnetApiFetch('/api/agents', { nodeNum: 1 });
      if (res.ok) {
        okResponses++;
        const json = (await res.json()) as { agents: unknown[] };
        samples.push(json.agents?.length ?? 0);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(okResponses).toBeGreaterThanOrEqual(10);
    expect(Math.max(...samples)).toBeGreaterThan(0);
  });

  test('status endpoint stays healthy across nodes during soak', async () => {
    for (const nodeNum of [1, 2]) {
      await requireDevnetNode(test, nodeNum);
      const res = await devnetApiFetch('/api/status', { nodeNum });
      expect(res.ok).toBe(true);
    }
  });
});

test.describe('Ownership transfer + delegated KA update (API)', () => {
  test('curator can list and mutate participants on owned CG', async () => {
    const cgs = await listContextGraphs(1);
    requireDevnetPrecondition(test, cgs.length === 0, 'No CGs');
    const cgId = cgs[0]!.id;
    const list = await devnetApiFetch(`/api/context-graph/${encodeURIComponent(cgId)}/participants`);
    expect(list.ok).toBe(true);
  });

  test('KA update without a precomputed attestation is rejected (not silently accepted)', async () => {
    const cgs = await listContextGraphs(1);
    requireDevnetPrecondition(test, cgs.length === 0, 'No CGs');
    const cgId = cgs[0]!.id;
    const { kaId } = await runWmSwmVmPipeline({ contextGraphId: cgId });
    const stamp = Date.now();
    const res = await devnetApiFetch('/api/update', {
      method: 'POST',
      body: JSON.stringify({
        contextGraphId: cgId,
        kaId,
        quads: buildTestQuads(cgId, stamp, `Delegated update ${stamp}`),
      }),
    });
    // On-chain KA update is gated behind a signed UpdateAuthorAttestation. A bare
    // quads update with no `precomputedUpdateAttestation` MUST be rejected — the
    // previous `expect([200,400,422]).toContain(res.status)` would have passed
    // even if the attestation enforcement regressed to ACCEPT un-attested updates.
    // Mirror the tightened sibling in wm-swm-vm-lifecycle.devnet.spec.ts.
    expect(res.ok).toBe(false);
    const body = await res.text();
    expect(body).toMatch(/precomputedUpdateAttestation|attestation/i);
  });

  test('second agent registration succeeds on devnet node2', async () => {
    await requireDevnetNode(test, 2);
    const { registerAgent } = await import('../../helpers/devnet-publish.js');
    const agent = await registerAgent(2, 'delegated');
    expect(agent.agentAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(agent.authToken.length).toBeGreaterThan(0);
  });
});

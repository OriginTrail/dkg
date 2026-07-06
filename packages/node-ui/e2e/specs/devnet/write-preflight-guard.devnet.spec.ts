/**
 * Write-preflight accept/deny boundary (#1408-B) — the security-critical part
 * of the store-outage rescue, pinned black-box.
 *
 * #1408 taught the write routes to survive a dead local store by admitting a
 * write target on positive on-chain proof it is an ACTIVE PUBLIC context
 * graph. The adversarial review on that PR caught (and fixed) a deny→accept
 * hole: an earlier draft rescued any SUBSCRIBED id, silently converting an
 * authorization deny into an accept. The invariant that survived — "an id the
 * node does not track is NEVER admitted; refusals are structured, side-effect
 * free, and leave the node healthy" — is exactly what this spec pins against
 * the healthy devnet. (The outage-only legs — 503 fail-closed, the on-chain
 * public rescue itself, oxigraph worker respawn — need a killed store and are
 * pinned by #1408's real-component suites: write-preflight-resilience,
 * storage-ack-core-unavailable, oxigraph-worker-respawn.)
 */
import { test, expect } from '../../fixtures/base.js';
import { devnetApiFetch, requireDevnetNode, requireDevnetPrecondition, waitForDevnetStatus } from '../../helpers/devnet.js';
import { buildTestQuads, createWmAssertion, listContextGraphs } from '../../helpers/devnet-publish.js';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await requireDevnetNode(test, 1);
  await waitForDevnetStatus(1);
});

/** Attempt a KA write into `cgId`; returns the raw response + parsed body. */
async function attemptWrite(cgId: string) {
  const stamp = Date.now();
  const res = await devnetApiFetch('/api/knowledge-assets', {
    method: 'POST',
    body: JSON.stringify({
      contextGraphId: cgId,
      name: `e2e-preflight-guard-${stamp}`,
      quads: buildTestQuads(cgId, stamp, `Preflight guard ${stamp}`),
      finalize: true,
    }),
  });
  let body: { code?: string; error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON refusals fail the assertions below on their own */
  }
  return { status: res.status, body };
}

test.describe('write-preflight refuses unknown targets, structured and side-effect free', () => {
  const bogusDid = `did:dkg:context-graph:e2e-preflight-unknown-${Date.now()}`;
  const bogusBare = `e2e-preflight-unknown-bare-${Date.now()}`;

  test('an unknown did-style CG id is a structured 400 CONTEXT_GRAPH_NOT_FOUND', async () => {
    const { status, body } = await attemptWrite(bogusDid);
    // NOT a 200 (shadow-CG accept — the #787/#1408 regression class) and NOT
    // a 503 (the store is healthy; unknown-target must be a definitive deny).
    expect(status, `unknown CG write must be denied, got ${status} ${JSON.stringify(body)}`).toBe(400);
    expect(body.code).toBe('CONTEXT_GRAPH_NOT_FOUND');
    expect(body.error).toContain(bogusDid);
  });

  test('an unknown bare CG name is refused the same way (list-leg miss)', async () => {
    const { status, body } = await attemptWrite(bogusBare);
    expect(status, `unknown bare CG write must be denied, got ${status} ${JSON.stringify(body)}`).toBe(400);
    expect(body.code).toBe('CONTEXT_GRAPH_NOT_FOUND');
  });

  test('the denies created no shadow CG and left the node fully writable', async () => {
    const cgs = await listContextGraphs(1);
    // No shadow-CG: neither rejected id may have materialized as a tracked CG.
    const ids = cgs.map((c) => c.id);
    expect(ids).not.toContain(bogusDid);
    expect(ids.some((id) => id.includes(bogusBare))).toBe(false);

    // Deny paths must be side-effect free: a normal write to a real CG still
    // works (the store did not wedge, no partial state was left behind).
    requireDevnetPrecondition(test, cgs.length === 0, 'No CGs on node1');
    const cgId = cgs[0]!.id;
    const stamp = Date.now();
    const ok = await createWmAssertion({
      contextGraphId: cgId,
      name: `e2e-preflight-after-deny-${stamp}`,
      quads: buildTestQuads(cgId, stamp, `After deny ${stamp}`),
    });
    expect(ok.ok, `valid write after denies failed: ${ok.status} ${ok.body}`).toBe(true);
  });
});

// memory_graph_changed emissions â€” NO MOCKS, real end-to-end SSE pipeline.
//
// The mutation routes call `ctx.emitMemoryGraphChanged(event)` after each
// create / write / finalize / promote / shared-memory write so the node-ui
// dashboard can refresh the affected layer. In the real daemon that callback
// `sseBroadcast`s a `memory_graph_changed` frame on `GET /api/events`
// (lifecycle.ts:2110). So instead of injecting an emitter stub and asserting on
// its captured calls, these tests SUBSCRIBE to the real `/api/events` SSE
// stream of a real edge daemon (startLiveDaemon vs the shared Hardhat node),
// drive the real routes over HTTP, and assert on the frames that actually
// arrive â€” the real emit pipeline, no fabricated daemon behaviour.
//
// Real-daemon facts pinned while writing this (the mock hid all of them):
//   - finalize (auto-finalize on create-with-quads, and POST â€¦/wm/finalize)
//     binds the author signature to the on-chain CG id, so it 500s unless the
//     context graph is REGISTERED on-chain first; create / wm/write / swm/share
//     / shared-memory write / finalize:false all work pre-registration.
//   - shared-memory writes to a named sub-graph require the sub-graph to be
//     registered first (POST /api/sub-graph/create).
//   - the `assertion_finalized` frame carries no `counts`; the write/promote
//     frames carry `counts.triples`.
//
// DEVNET-TIER (documented, NOT faked here â€” needs real core peers):
//   - the confirmed selective-publish SWM+VM emission and the publish remap
//     paths: a confirmed publish mints on-chain + needs StorageACK quorum from
//     connected core peers, which a single edge daemon cannot reach.
//   - the VM verify verified/partial/no_quorum emissions: each needs a real
//     multi-signer quorum state, which only arises on a curated devnet.
//   - the per-KA vm/publish mint path: observable only through what the
//     publish actually mints on-chain, i.e. the devnet tier.
//   - the callerAgentAddress threaded into agent.share / conditionalShare: an
//     internal argument the live HTTP surface does not expose (the write's
//     outcome is asserted instead).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startLiveDaemon,
  stopLiveDaemon,
  postJson,
  getJson,
  openEventStream,
  type LiveDaemon,
  type EventStream,
} from './helpers/live-daemon.js';

const QUADS = [{ subject: 'urn:root', predicate: 'http://schema.org/name', object: '"v1"' }];

describe('memory_graph_changed â€” real daemon SSE emissions', () => {
  let daemon: LiveDaemon;
  let stream: EventStream;
  let cgCounter = 0;

  beforeAll(async () => {
    daemon = await startLiveDaemon({ authEnabled: false });
    stream = await openEventStream(daemon);
  }, 90_000);

  afterAll(async () => {
    stream?.close();
    await stopLiveDaemon(daemon);
  });

  // A fresh, uniquely-named context graph per test so emitted frames are
  // isolated by contextGraphId (no cross-test event matching). Optionally
  // register it on-chain (required before finalize).
  async function freshCg(register = false): Promise<string> {
    const id = `mge-${cgCounter++}`;
    const created = await postJson(daemon, '/api/context-graph/create', { id, name: id });
    expect(created.status).toBe(200);
    if (register) {
      const reg = await postJson(daemon, '/api/context-graph/register', { id });
      expect(reg.status).toBe(200);
    }
    return id;
  }

  const isFrame = (cg: string, operation: string) => (f: { event: string; data: any }) =>
    f.event === 'memory_graph_changed' && f.data?.contextGraphId === cg && f.data?.operation === operation;

  // Confirm an op did NOT emit `operation` for `cg`: drive a sentinel create on
  // the same cg, await its (ordered) frame, then assert the unwanted frame
  // never arrived. SSE is ordered, so if it isn't present by the sentinel it
  // never will be.
  async function expectNoEmit(cg: string, operation: string): Promise<void> {
    const sentinelName = `sentinel-${cgCounter++}`;
    const res = await postJson(daemon, '/api/knowledge-assets', { contextGraphId: cg, name: sentinelName });
    expect(res.status).toBe(201);
    await stream.waitFor(isFrame(cg, 'assertion_created'), 8000);
    expect(stream.events.some(isFrame(cg, operation))).toBe(false);
  }

  it('emits an assertion_created refresh on POST /api/knowledge-assets (create)', async () => {
    const cg = await freshCg();
    const res = await postJson(daemon, '/api/knowledge-assets', { contextGraphId: cg, name: 'draft' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'draft-open' });
    const frame = await stream.waitFor(isFrame(cg, 'assertion_created'));
    expect(frame.data).toMatchObject({ contextGraphId: cg, layers: ['wm'], operation: 'assertion_created', source: 'api', counts: { triples: 0 } });
    expect(typeof frame.data.timestamp).toBe('string');
  });

  it('emits an assertion_written refresh after POST â€¦/wm/write', async () => {
    const cg = await freshCg();
    const res = await postJson(daemon, '/api/knowledge-assets/draft/wm/write', { contextGraphId: cg, quads: QUADS });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ written: 1 });
    const frame = await stream.waitFor(isFrame(cg, 'assertion_written'));
    expect(frame.data).toMatchObject({ contextGraphId: cg, layers: ['wm'], operation: 'assertion_written', source: 'api', counts: { triples: 1 } });
  });

  it('auto-finalizes a create-with-quads on a registered CG â€” writes AND seals, emits assertion_finalized', async () => {
    const cg = await freshCg(true);
    const res = await postJson(daemon, '/api/knowledge-assets', { contextGraphId: cg, name: 'sealed', quads: QUADS });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ written: 1, status: 'wm-sealed' });
    expect(String(res.body.merkleRoot)).toMatch(/^0x[0-9a-f]{64}$/);
    const frame = await stream.waitFor(isFrame(cg, 'assertion_finalized'));
    expect(frame.data).toMatchObject({ contextGraphId: cg, layers: ['wm'], operation: 'assertion_finalized', source: 'api' });
  });

  it('honors finalize:false â€” writes quads but does NOT seal (assertion_written, no assertion_finalized)', async () => {
    const cg = await freshCg();
    const res = await postJson(daemon, '/api/knowledge-assets', { contextGraphId: cg, name: 'draft', quads: QUADS, finalize: false });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ written: 1, status: 'draft-open' });
    expect(res.body).not.toHaveProperty('merkleRoot');
    await stream.waitFor(isFrame(cg, 'assertion_written'));
    expect(stream.events.some(isFrame(cg, 'assertion_finalized'))).toBe(false);
  });

  it('emits an assertion_finalized refresh on POST â€¦/wm/finalize (registered CG)', async () => {
    const cg = await freshCg(true);
    await postJson(daemon, '/api/knowledge-assets/draft/wm/write', { contextGraphId: cg, quads: QUADS });
    const res = await postJson(daemon, '/api/knowledge-assets/draft/wm/finalize', { contextGraphId: cg });
    expect(res.status).toBe(200);
    expect(String(res.body.merkleRoot)).toMatch(/^0x[0-9a-f]{64}$/);
    const frame = await stream.waitFor(isFrame(cg, 'assertion_finalized'));
    expect(frame.data).toMatchObject({ contextGraphId: cg, layers: ['wm'], operation: 'assertion_finalized', source: 'api' });
  });

  it('emits WM+SWM refresh events after assertion sharing (swm/share)', async () => {
    const cg = await freshCg();
    await postJson(daemon, '/api/knowledge-assets/draft/wm/write', { contextGraphId: cg, quads: QUADS });
    const res = await postJson(daemon, '/api/knowledge-assets/draft/swm/share', { contextGraphId: cg, entities: ['urn:root'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ swmShared: true });
    const frame = await stream.waitFor(isFrame(cg, 'assertion_promoted'));
    expect(frame.data).toMatchObject({ contextGraphId: cg, layers: ['wm', 'swm'], operation: 'assertion_promoted', source: 'api' });
    expect(frame.data.counts.triples).toBeGreaterThanOrEqual(1);
  });

  it('does not emit for the removed shared-memory write route', async () => {
    const cg = await freshCg();
    const res = await postJson(daemon, '/api/shared-memory/write', { contextGraphId: cg, quads: QUADS });
    expect(res.status).toBe(404);
    await expectNoEmit(cg, 'shared_memory_written');
  });

  it('writes /api/memory/turn through a named WM knowledge asset when layer is omitted', async () => {
    const cg = await freshCg();
    const res = await postJson(daemon, '/api/memory/turn', {
      contextGraphId: cg,
      markdown: '# Turn\n\nUser likes lifecycle-backed memory.',
      sessionUri: 'urn:test:session:memory-turn',
      turnId: 'memory-turn-route-regression',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      layer: 'wm',
      sessionUri: 'urn:test:session:memory-turn',
    });
    expect(res.body.assertionName).toMatch(/^turn-[0-9a-f]{32}$/);
    expect(typeof res.body.graph).toBe('string');
    expect(res.body.graph.length).toBeGreaterThan(0);

    const frame = await stream.waitFor(isFrame(cg, 'memory_turn_written'));
    expect(frame.data).toMatchObject({
      contextGraphId: cg,
      layers: ['wm'],
      operation: 'memory_turn_written',
      source: 'memory-turn',
    });

    const quads = await getJson(
      daemon,
      `/api/knowledge-assets/${encodeURIComponent(res.body.assertionName)}/wm/quads?contextGraphId=${encodeURIComponent(cg)}`,
    );
    expect(quads.status).toBe(200);
    expect(JSON.stringify(quads.body)).toContain(res.body.turnUri);
    expect(JSON.stringify(quads.body)).toContain('ConversationTurn');

    const search = await postJson(daemon, '/api/memory/search', {
      contextGraphId: cg,
      query: 'lifecycle-backed memory',
    });
    expect(search.status).toBe(200);
    expect(search.body.results.some((hit: any) => hit.entityUri === res.body.turnUri)).toBe(true);
  });

  it('rejects /api/memory/turn requests that still target SWM directly', async () => {
    const cg = await freshCg();
    const res = await postJson(daemon, '/api/memory/turn', {
      contextGraphId: cg,
      markdown: 'Do not write this directly to SWM.',
      layer: 'swm',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only supports layer:"wm"/);
  });

  it('rejects finalize:false combined with alsoShareSwm before any mutation', async () => {
    const cg = await freshCg();
    const res = await postJson(daemon, '/api/knowledge-assets', { contextGraphId: cg, name: 'draft', quads: QUADS, finalize: false, alsoShareSwm: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/require a finalized assertion/);
    await expectNoEmit(cg, 'assertion_promoted');
  });

  it('rejects alsoShareSwm with no quads (nothing to seal) before any mutation', async () => {
    const cg = await freshCg();
    const res = await postJson(daemon, '/api/knowledge-assets', { contextGraphId: cg, name: 'draft', alsoShareSwm: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/require a finalized assertion/);
  });

  it('rejects verify-batch without explicit batch quads before reading local graphs', async () => {
    const cg = await freshCg();
    const res = await postJson(daemon, '/api/shared-memory/verify-batch', { contextGraphId: cg, expectedMerkleRoot: `0x${'11'.repeat(32)}` });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/requires explicit `quads`/);
  });

  it('accepts explicit verify-batch quads over the small request limit (â‰ˆ270 KB, not 413)', async () => {
    const cg = await freshCg();
    const largeLiteral = `"${'x'.repeat(270 * 1024)}"`;
    const res = await postJson(daemon, '/api/shared-memory/verify-batch', {
      contextGraphId: cg,
      expectedMerkleRoot: `0x${'11'.repeat(32)}`,
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: largeLiteral }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ quadsConsidered: 1, ok: false });
  });
});

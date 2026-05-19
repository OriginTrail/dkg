// /api/slo route-level wire-format regression test.
//
// rc.9 PR-A added two new top-level sections (`gossip`, `swm`) to
// the `/api/slo` response. Codex review on PR #570 R10 caught that
// the PR only exercised the internal getters/handlers; the public
// HTTP wire shape was untested, making it easy to silently break
// later — especially the cold-start case where `sharedMemoryHandler`
// is still undefined and the receiver-side stats getter must return
// the pristine snapshot.
//
// We pin the wire shape by exercising the production `buildSloPayload`
// helper (which the live route also calls) through a real HTTP
// roundtrip via `jsonResponse`. If the route's bundling shape, the
// helper's field names, or any of the three getters' return shape
// changes, this test fails — protecting soak tooling + operators
// from a silent breaking change.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { jsonResponse } from '../src/daemon/http-utils.js';
import { buildSloPayload } from '../src/daemon/routes/agent-chat.js';

type FakeAgent = Parameters<typeof buildSloPayload>[0];

async function startSloServer(agent: FakeAgent): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/slo') {
      return jsonResponse(res, 200, buildSloPayload(agent));
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('server addr unavailable');
  return { server, port: addr.port };
}

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

describe('/api/slo wire format (rc.9 PR-A / Codex PR #570 R10)', () => {
  let server: Server | null = null;
  let port = 0;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
      server = null;
    }
  });

  it('pristine cold-start payload — all three sections present, all empty/zero', async () => {
    const agent: FakeAgent = {
      getMessengerSloStats: () => ({}),
      getSwmGossipStats: () => ({
        publishFailures: {},
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      }),
      getSwmHandlerStats: () => ({
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
      }),
    };
    ({ server, port } = await startSloServer(agent));

    const { status, body } = await get(port, '/api/slo');
    expect(status).toBe(200);
    expect(body).toEqual({
      protocols: {},
      gossip: {
        publishFailures: {},
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      },
      swm: {
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
      },
    });
  });

  it('populated payload — every field flows through end-to-end', async () => {
    const agent: FakeAgent = {
      getMessengerSloStats: () => ({
        '/dkg/10.0.1/message': {
          samples: 847,
          p50Ms: 42,
          p95Ms: 380,
          p99Ms: 1240,
          delivered: 1602,
          queued: 14,
        },
      }),
      getSwmGossipStats: () => ({
        publishFailures: { 'did:dkg:context-graph:lex/playground': 3 },
        publishFailuresOverflow: 7,
        publishFailuresTruncated: true,
      }),
      getSwmHandlerStats: () => ({
        redundantApplies: { 'did:dkg:context-graph:lex/playground': 5 },
        redundantAppliesLowerBound: true,
        redundantAppliesOverflow: 11,
        redundantAppliesTruncated: true,
      }),
    };
    ({ server, port } = await startSloServer(agent));

    const { status, body } = await get(port, '/api/slo');
    expect(status).toBe(200);
    expect(body).toEqual({
      protocols: {
        '/dkg/10.0.1/message': {
          samples: 847,
          p50Ms: 42,
          p95Ms: 380,
          p99Ms: 1240,
          delivered: 1602,
          queued: 14,
        },
      },
      gossip: {
        publishFailures: { 'did:dkg:context-graph:lex/playground': 3 },
        publishFailuresOverflow: 7,
        publishFailuresTruncated: true,
      },
      swm: {
        redundantApplies: { 'did:dkg:context-graph:lex/playground': 5 },
        redundantAppliesLowerBound: true,
        redundantAppliesOverflow: 11,
        redundantAppliesTruncated: true,
      },
    });
  });

  /**
   * rc.9 PR-C wire-format regression: when the agent exposes
   * `getSwmSubstrateFanoutStats()`, /api/slo MUST surface it under
   * `swm.substrateFanout`. The interface marks the getter optional
   * so test doubles can omit it; the agent's production
   * implementation always provides it.
   */
  it('substrateFanout — when provided, nested under swm with all four outcome maps + overflow', async () => {
    const agent: FakeAgent = {
      getMessengerSloStats: () => ({}),
      getSwmGossipStats: () => ({
        publishFailures: {},
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      }),
      getSwmHandlerStats: () => ({
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
      }),
      getSwmSubstrateFanoutStats: () => ({
        delivered: { 'did:dkg:context-graph:lex/curated': 47 },
        rejected: { 'did:dkg:context-graph:lex/curated': 4 },
        queued: { 'did:dkg:context-graph:lex/curated': 2 },
        inFlight: {},
        failed: { 'did:dkg:context-graph:bigpublic': 1 },
        overflow: { delivered: 12, rejected: 2, queued: 3, inFlight: 0, failed: 5 },
        truncated: true,
      }),
    };
    ({ server, port } = await startSloServer(agent));

    const { status, body } = await get(port, '/api/slo');
    expect(status).toBe(200);
    expect(body).toEqual({
      protocols: {},
      gossip: {
        publishFailures: {},
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      },
      swm: {
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
        substrateFanout: {
          delivered: { 'did:dkg:context-graph:lex/curated': 47 },
          rejected: { 'did:dkg:context-graph:lex/curated': 4 },
          queued: { 'did:dkg:context-graph:lex/curated': 2 },
          inFlight: {},
          failed: { 'did:dkg:context-graph:bigpublic': 1 },
          overflow: { delivered: 12, rejected: 2, queued: 3, inFlight: 0, failed: 5 },
          truncated: true,
        },
      },
    });
  });

  /**
   * rc.9 PR-D wire-format regression: when the agent exposes
   * `getSwmAckQuorumStats()`, /api/slo MUST surface it under
   * `swm.shareAckQuorum`. Mirrors the PR-C pattern so test doubles
   * can opt-out and production agents always supply it.
   */
  it('shareAckQuorum — when provided, nested under swm with all five counters', async () => {
    const agent: FakeAgent = {
      getMessengerSloStats: () => ({}),
      getSwmGossipStats: () => ({
        publishFailures: {},
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      }),
      getSwmHandlerStats: () => ({
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
      }),
      getSwmAckQuorumStats: () => ({
        tracked: 1024,
        completed: 998,
        watchdogFired: 21,
        deadlineExpired: 5,
        pending: 7,
      }),
    };
    ({ server, port } = await startSloServer(agent));

    const { status, body } = await get(port, '/api/slo');
    expect(status).toBe(200);
    expect(body).toEqual({
      protocols: {},
      gossip: {
        publishFailures: {},
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      },
      swm: {
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
        shareAckQuorum: {
          tracked: 1024,
          completed: 998,
          watchdogFired: 21,
          deadlineExpired: 5,
          pending: 7,
        },
      },
    });
  });

  it('shareAckQuorum — absent when the agent omits getSwmAckQuorumStats (back-compat with pre-PR-D doubles)', async () => {
    const agent: FakeAgent = {
      getMessengerSloStats: () => ({}),
      getSwmGossipStats: () => ({
        publishFailures: {},
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      }),
      getSwmHandlerStats: () => ({
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
      }),
    };
    ({ server, port } = await startSloServer(agent));

    const { status, body } = await get(port, '/api/slo');
    expect(status).toBe(200);
    expect((body as { swm: Record<string, unknown> }).swm.shareAckQuorum).toBeUndefined();
  });

  /**
   * rc.9 PR-D (codex follow-up from PR-G #G1): agents that ship
   * the `retryable` outcome bucket (transient receiver-side
   * rejections — CAS pre-condition not yet met, etc.) must
   * see it surface end-to-end on `/api/slo`. Operators rely
   * on this to distinguish "share dropped permanently" from
   * "share will retry shortly via watchdog top-up", which
   * have very different incident-response implications.
   */
  it('substrateFanout — retryable bucket (PR-D, codex from PR-G #G1) flows through end-to-end', async () => {
    const agent: FakeAgent = {
      getMessengerSloStats: () => ({}),
      getSwmGossipStats: () => ({
        publishFailures: {},
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      }),
      getSwmHandlerStats: () => ({
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
      }),
      getSwmSubstrateFanoutStats: () => ({
        delivered: { 'did:dkg:context-graph:curated': 10 },
        rejected: {},
        retryable: { 'did:dkg:context-graph:curated': 3 },
        queued: {},
        inFlight: {},
        failed: {},
        overflow: { delivered: 0, rejected: 0, retryable: 7, queued: 0, inFlight: 0, failed: 0 },
        truncated: false,
      }),
    };
    ({ server, port } = await startSloServer(agent));

    const { status, body } = await get(port, '/api/slo');
    expect(status).toBe(200);
    const substrateFanout = (body as { swm: { substrateFanout: Record<string, unknown> } }).swm.substrateFanout;
    expect(substrateFanout.retryable).toEqual({ 'did:dkg:context-graph:curated': 3 });
    expect((substrateFanout.overflow as Record<string, number>).retryable).toBe(7);
  });

  it('substrateFanout — absent when the agent omits getSwmSubstrateFanoutStats (back-compat with PR-A-only doubles)', async () => {
    const agent: FakeAgent = {
      getMessengerSloStats: () => ({}),
      getSwmGossipStats: () => ({
        publishFailures: {},
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      }),
      getSwmHandlerStats: () => ({
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
      }),
    };
    ({ server, port } = await startSloServer(agent));

    const { status, body } = await get(port, '/api/slo');
    expect(status).toBe(200);
    // Stricter than toEqual w/ partial — assert the key is genuinely absent.
    expect((body as { swm: Record<string, unknown> }).swm.substrateFanout).toBeUndefined();
  });

  it('partial / mid-life payload — gossip populated, swm pristine', async () => {
    const agent: FakeAgent = {
      getMessengerSloStats: () => ({}),
      getSwmGossipStats: () => ({
        publishFailures: { 'cg-with-failures': 1 },
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      }),
      getSwmHandlerStats: () => ({
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
      }),
    };
    ({ server, port } = await startSloServer(agent));

    const { status, body } = await get(port, '/api/slo');
    expect(status).toBe(200);
    expect(body).toEqual({
      protocols: {},
      gossip: {
        publishFailures: { 'cg-with-failures': 1 },
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      },
      swm: {
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
      },
    });
  });
});

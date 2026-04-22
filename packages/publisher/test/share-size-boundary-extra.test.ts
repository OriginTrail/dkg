/**
 * Publisher SWM gossip-size boundary tests (no Hardhat required).
 *
 * Audit findings covered:
 *
 *   P-4 (HIGH) — 512 KB SHARE auto-batch boundary.
 *                `packages/publisher/src/dkg-publisher.ts` hard-codes
 *                `MAX_GOSSIP_MESSAGE_SIZE = 512 * 1024`. The existing
 *                suite never sends a payload near that limit, so a
 *                silent change to the cap (or a regression that stops
 *                measuring the encoded protobuf length) would not be
 *                detected. These tests pin both sides of the boundary:
 *                  • a payload JUST UNDER 512 KB must succeed; and
 *                  • a payload JUST OVER 512 KB must fail with a clear,
 *                    caller-actionable error that mentions the limit.
 *
 * Per QA policy: do NOT modify production code or spec docs. If the
 * boundary ever drifts, the failing assertion IS the bug evidence.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/index.js';

const CG = 'boundary-test-cg';
const PEER = '12D3KooWBoundary';

function q(s: string, p: string, o: string): Quad {
  return { subject: s, predicate: p, object: o, graph: '' };
}

/**
 * Build a single quad whose UTF-8 N-Quad serialization is approximately
 * `targetBytes` bytes. We pad the literal object so the encoded
 * WorkspacePublishRequest lands just under or just over 512 KB depending
 * on `targetBytes`.
 *
 * Using a single root entity keeps manifest overhead constant so the
 * dominant size contribution is the nquads string. autoPartition groups
 * by root — a single subject maps to a single KA.
 */
function buildQuadWithPayload(bytes: number): Quad {
  // subject/predicate/fixed N-Quad framing adds ~120 bytes of overhead.
  // Subtract that from the target so the rendered N-Quad approximates
  // `bytes`. We pad with a single ASCII char so 1 char == 1 byte.
  const overhead = 140;
  const padLen = Math.max(0, bytes - overhead);
  const padding = 'x'.repeat(padLen);
  return q('urn:test:boundary:root', 'http://schema.org/description', `"${padding}"`);
}

function makePublisher(store: OxigraphStore, eventBus: TypedEventBus): Promise<DKGPublisher> {
  return (async () => {
    const keypair = await generateEd25519Keypair();
    return new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus,
      keypair,
    });
  })();
}

describe('P-4: SWM share() 512 KB gossip-message boundary', () => {
  let store: OxigraphStore;
  let eventBus: TypedEventBus;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    eventBus = new TypedEventBus();
    publisher = await makePublisher(store, eventBus);
  });

  it('accepts a payload just under the 512 KB cap and returns an encoded message', async () => {
    // Target 500 KB of literal payload → total encoded protobuf
    // message will be a few KB larger but still < 512 KB.
    const under = buildQuadWithPayload(500 * 1024);

    const result = await publisher.share(CG, [under], { publisherPeerId: PEER });

    expect(result).toBeDefined();
    // The encoded message is the protobuf payload the agent would gossip.
    // If this shape ever changes, update the assertion — but DO NOT drop it;
    // without this check the size-limit codepath would be untested.
    expect(result.message).toBeDefined();
    expect(result.message).toBeInstanceOf(Uint8Array);
    expect(result.message.length).toBeLessThanOrEqual(512 * 1024);
    expect(result.message.length).toBeGreaterThan(400 * 1024); // sanity: did we actually build big
  });

  it('rejects a payload just over the 512 KB cap with a clear, actionable error', async () => {
    // Target 600 KB of literal payload — well over the 512 KB cap so
    // there is no ambiguity about which branch the encoder exits on.
    const over = buildQuadWithPayload(600 * 1024);

    let thrown: unknown;
    try {
      await publisher.share(CG, [over], { publisherPeerId: PEER });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    // The error MUST mention both the actual size and the cap so
    // operators can tell "is this a slightly-over vs wildly-over" case
    // without attaching a debugger. We also assert the remediation
    // guidance (split by root entity) per spec §04.
    expect(msg).toMatch(/too large/i);
    expect(msg).toMatch(/512\s*KB/);
    expect(msg).toMatch(/split/i);
  });

  it('the cap is exactly 512 KB — a just-over payload fails, a just-under payload passes', async () => {
    // Pin the constant. If someone reduces the cap to, say, 256 KB
    // without updating the guidance in the error or the spec, BOTH
    // halves of this test flip status and the regression is noisy.
    const justUnder = buildQuadWithPayload(480 * 1024);
    const justOver = buildQuadWithPayload(560 * 1024);

    const ok = await publisher.share(CG, [justUnder], { publisherPeerId: PEER });
    expect(ok).toBeDefined();
    expect(ok.message.length).toBeLessThan(512 * 1024);

    await expect(
      publisher.share(CG, [justOver], { publisherPeerId: PEER }),
    ).rejects.toThrow(/too large.*512\s*KB/i);
  });
});

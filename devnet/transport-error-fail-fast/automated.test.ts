/**
 * Typed transport-error classification against REAL devnet nodes.
 *
 * Preconditions:
 *   pnpm run build
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *
 * `ProtocolRouter.send()` used to retry a peer that refused the protocol
 * ("Protocol selection failed - could not negotiate ...") three times with a
 * 500 ms + 1000 ms backoff, because the substring classifier listed those
 * words as recoverable. This suite drives a real, in-process `ProtocolRouter`
 * (its own libp2p node, connected to the running devnet) at the real devnet
 * daemons and pins the corrected behaviour:
 *
 *  - a devnet node that does not handle a protocol fails the send FAST, in a
 *    single dial, with libp2p's typed `UnsupportedProtocolError`;
 *  - the natural non-negotiating peer on the devnet is an EDGE node with
 *    respect to StorageACK (only cores register that handler). It fails the
 *    same way, and `isProtocolUnsupportedError` still matches it: that
 *    predicate is what the publisher's ACK collector counts as
 *    peer-unreachable (`protocol_unsupported`) against the quorum;
 *  - a CORE that does speak StorageACK is never classified as refusing.
 *
 * ISOLATION: read-only against the devnet. The only entity created is this
 * process's own ephemeral libp2p node; no chain state, node wallet, node
 * config or shared context graph is touched, and no node is restarted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DKGNode } from '../../packages/core/src/node.js';
import {
  ProtocolRouter,
  isProtocolUnsupportedError,
  isRecoverableSendError,
} from '../../packages/core/src/protocol-router.js';
import { PROTOCOL_STORAGE_ACK } from '../../packages/core/src/constants.js';
import { classifyTransportError } from '../../packages/core/src/transport-error.js';
import { detectDevnet, fetchRetry, waitFor } from '../_bootstrap/harness.js';

const NODE_COUNT = Number(process.env.DEVNET_NODE_COUNT ?? 6);
/** Before the fix a refused protocol cost >= 500 ms + 1000 ms of backoff. */
const FAIL_FAST_BUDGET_MS = 1_000;
/** A protocol no devnet node registers. */
const UNREGISTERED_PROTOCOL = '/dkg/10.0.1/devnet-transport-error-probe';

const enc = new TextEncoder();

interface DevnetPeer {
  num: number;
  role: string;
  peerId: string;
  listenPort: number;
}

let peers: DevnetPeer[] = [];
let probeNode: DKGNode | null = null;
let router: ProtocolRouter | null = null;

async function loadPeer(num: number, apiPort: number, home: string): Promise<DevnetPeer> {
  const res = await fetchRetry(`http://127.0.0.1:${apiPort}/api/status`);
  if (!res.ok) throw new Error(`node${num} /api/status failed: ${res.status}`);
  const status = (await res.json()) as { peerId?: string; nodeRole?: string };
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { listenPort?: number };
  if (!status.peerId || !status.nodeRole || !config.listenPort) {
    throw new Error(`node${num} is missing peerId/nodeRole/listenPort (status=${JSON.stringify(status)})`);
  }
  return { num, role: status.nodeRole, peerId: status.peerId, listenPort: config.listenPort };
}

beforeAll(async () => {
  const state = await detectDevnet(NODE_COUNT);
  if (!state) {
    throw new Error(`Live ${NODE_COUNT}-node devnet not detected. Run ./scripts/devnet.sh start ${NODE_COUNT} first.`);
  }
  // Loaded in parallel; Promise.all keeps the nodes in ascending node-number order.
  peers = await Promise.all(
    Object.keys(state.nodes).map(Number).sort((a, b) => a - b).map((num) => loadPeer(num, state.nodes[num].apiPort, state.nodes[num].home)),
  );

  // An ephemeral libp2p node of our own, bootstrapped to every devnet node.
  probeNode = new DKGNode({
    listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
    enableMdns: false,
    bootstrapPeers: peers.map((p) => `/ip4/127.0.0.1/tcp/${p.listenPort}/p2p/${p.peerId}`),
  });
  await probeNode.start();
  router = new ProtocolRouter(probeNode);
  const node = probeNode;
  await waitFor('probe node connected to every devnet node', 45_000, 500, async () => {
    const connected = new Set(node.libp2p.getPeers().map((p) => p.toString()));
    return peers.every((p) => connected.has(p.peerId)) ? true : null;
  });
  // eslint-disable-next-line no-console
  console.log(`[transport-error-fail-fast] devnet: ${peers.map((p) => `node${p.num}=${p.role}`).join(' ')}`);
}, 90_000);

afterAll(async () => {
  await router?.closePooling();
  if (probeNode?.isStarted) await probeNode.stop();
});

function requireHarness(): { node: DKGNode; router: ProtocolRouter } {
  if (!probeNode || !router) throw new Error('probe node was not started');
  return { node: probeNode, router };
}

async function timedSend(
  peerId: string,
  protocol: string,
  payload: Uint8Array,
): Promise<{ failure: unknown; elapsedMs: number; dials: number }> {
  const { node, router: r } = requireHarness();
  const dialSpy = vi.spyOn(node.libp2p, 'dialProtocol');
  try {
    const startedAt = Date.now();
    const failure = await r.send(peerId, protocol, payload).then(() => undefined, (err: unknown) => err);
    return { failure, elapsedMs: Date.now() - startedAt, dials: dialSpy.mock.calls.length };
  } finally {
    dialSpy.mockRestore();
  }
}

describe('typed transport-error classification against real devnet nodes', () => {
  it('sees a devnet with both cores and edges', () => {
    expect(peers).toHaveLength(NODE_COUNT);
    expect(peers.filter((p) => p.role === 'core').length).toBeGreaterThan(0);
    expect(peers.filter((p) => p.role === 'edge').length).toBeGreaterThan(0);
  });

  it('every devnet node fails a send of an unregistered protocol FAST, in one dial, with libp2p\'s typed error', async () => {
    for (const peer of peers) {
      const { failure, elapsedMs, dials } = await timedSend(
        peer.peerId,
        UNREGISTERED_PROTOCOL,
        enc.encode('devnet-probe'),
      );
      const label = `node${peer.num} (${peer.role})`;
      expect(failure, label).toBeInstanceOf(Error);
      expect((failure as Error).name, label).toBe('UnsupportedProtocolError');
      expect(classifyTransportError(failure), label).toBe('ProtocolUnsupported');
      expect(isProtocolUnsupportedError(failure), label).toBe(true);
      expect(isRecoverableSendError(failure), label).toBe(false);
      // One dial, no backoff. (Before: three dials and >= 1.5 s.)
      expect(dials, label).toBe(1);
      expect(elapsedMs, `${label} took ${elapsedMs} ms`).toBeLessThan(FAIL_FAST_BUDGET_MS);
    }
  }, 60_000);

  it('an EDGE does not speak StorageACK: probe says unsupported and a send fails fast (what the ACK collector counts as unreachable)', async () => {
    const { router: r } = requireHarness();
    const edges = peers.filter((p) => p.role === 'edge');
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      const label = `node${edge.num} (edge)`;
      expect(await r.probeProtocol(edge.peerId, PROTOCOL_STORAGE_ACK), label).toBe('unsupported');
      const { failure, elapsedMs, dials } = await timedSend(
        edge.peerId,
        PROTOCOL_STORAGE_ACK,
        enc.encode('not-a-real-publish-intent'),
      );
      expect(isProtocolUnsupportedError(failure), label).toBe(true);
      expect(isRecoverableSendError(failure), label).toBe(false);
      expect(dials, label).toBe(1);
      expect(elapsedMs, `${label} took ${elapsedMs} ms`).toBeLessThan(FAIL_FAST_BUDGET_MS);
    }
  }, 60_000);

  it('a CORE that does speak StorageACK is never classified as refusing the protocol', async () => {
    const { router: r } = requireHarness();
    const cores = peers.filter((p) => p.role === 'core');
    expect(cores.length).toBeGreaterThan(0);
    for (const core of cores) {
      const label = `node${core.num} (core)`;
      expect(await r.probeProtocol(core.peerId, PROTOCOL_STORAGE_ACK), label).toBe('supported');
      // A real (malformed) request: the core's handler may answer or reset the
      // stream, but it must never look like "the peer does not speak this".
      const { failure } = await timedSend(core.peerId, PROTOCOL_STORAGE_ACK, enc.encode('not-a-real-publish-intent'));
      expect(isProtocolUnsupportedError(failure), label).toBe(false);
      if (failure !== undefined) {
        expect(classifyTransportError(failure), label).not.toBe('ProtocolUnsupported');
      }
    }
  }, 120_000);
});

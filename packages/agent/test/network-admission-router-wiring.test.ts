import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GENESIS_ID,
  PROTOCOL_SYNC,
  PROTOCOL_SYNC_POOLED,
  computeNetworkId,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';

/**
 * Proves the PRODUCTION admission wiring, not a manually injected router: a
 * peer whose cached verdict is "rejected" must have its inbound streams dropped
 * BEFORE any request bytes are read and WITHOUT the probing admission check
 * running — on both inbound transports (one-shot sync and pooled sync).
 *
 * Core-level tests inject `isPeerKnownRejected` by hand; this test would keep
 * passing with that wiring deleted from `dkg-agent-lifecycle.ts`, which is
 * exactly the silent regression it exists to catch. Everything here goes
 * through `DKGAgent.create(...).start()` and the real
 * NetworkAdmissionCoordinator; the only test double is the inbound stream.
 *
 * Two vacuous-pass traps this deliberately avoids:
 * - `networkIdentity` must be configured, else admission is disabled and
 *   `isRejectedPeer` returns false for everyone (the gate would no-op and the
 *   assertions below would still fail loudly — reads would be > 0).
 * - the quarantined peer id must be VALID: `isRejectedPeer` returns true for
 *   any unparseable id once admission is enabled, which would fake a pass for
 *   a gate wired to the wrong predicate.
 */

const REJECTED_PEER = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';

class CountingInboundStream extends EventTarget {
  sent: Uint8Array | null = null;
  aborted: Error | null = null;
  reads = 0;

  send(data: Uint8Array): void {
    this.sent = data;
  }

  async close(): Promise<void> {}

  abort(error: Error): void {
    this.aborted = error;
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        this.reads += 1;
        return { value: undefined as unknown as Uint8Array, done: true };
      },
    };
  }
}

describe('production router admission wiring', () => {
  it('drops inbound streams from a cache-rejected peer before reading, on both sync transports', async () => {
    const networkId = await computeNetworkId(DEFAULT_GENESIS_ID);
    const agent = await DKGAgent.create({
      name: 'AdmissionRouterWiring',
      listenPort: 0,
      store: new OxigraphStore(),
      networkIdentity: {
        genesisId: DEFAULT_GENESIS_ID,
        networkId,
        chainId: 'chain:1',
      },
    });

    // Capture every libp2p protocol handler the lifecycle registers. node.start()
    // completes before router construction, so patching `handle` right after the
    // real start observes all registrations (direct AND pooled wire).
    const captured = new Map<
      string,
      (stream: unknown, connection: unknown) => unknown
    >();
    const realNodeStart = agent.node.start.bind(agent.node);
    (agent.node as unknown as { start: () => Promise<void> }).start = async () => {
      await realNodeStart();
      const lp = agent.node.libp2p as unknown as {
        handle: (protocol: string, handler: (stream: unknown, connection: unknown) => unknown, opts?: unknown) => unknown;
      };
      const realHandle = lp.handle.bind(lp);
      lp.handle = (protocol, handler, opts) => {
        captured.set(protocol, handler);
        return realHandle(protocol, handler, opts);
      };
    };

    try {
      await agent.start();

      // If pooled sync is ever flag-flipped off in CI this fails loudly here
      // instead of silently testing half the surface.
      expect(captured.has(PROTOCOL_SYNC)).toBe(true);
      expect(captured.has(PROTOCOL_SYNC_POOLED)).toBe(true);

      // The REAL cached verdict, through the REAL service the lifecycle wires.
      agent.networkAdmission.quarantinePeer(REJECTED_PEER);
      expect(agent.networkAdmission.isRejectedPeer(REJECTED_PEER)).toBe(true);

      const coordinator = (
        agent as unknown as { networkAdmissionCoordinator: { ensureAdmitted: (...args: unknown[]) => Promise<boolean> } }
      ).networkAdmissionCoordinator;
      const ensureAdmittedSpy = vi.spyOn(coordinator, 'ensureAdmitted');

      const connection = {
        remotePeer: {
          toString: () => REJECTED_PEER,
          toMultihash: () => ({ bytes: new Uint8Array([1, 2, 3]) }),
        },
      };

      const directStream = new CountingInboundStream();
      await captured.get(PROTOCOL_SYNC)!(directStream, connection);

      const pooledStream = new CountingInboundStream();
      await captured.get(PROTOCOL_SYNC_POOLED)!(pooledStream, connection);
      // Pool accept is fire-and-forget internally; let its microtasks settle.
      for (let i = 0; i < 30; i++) await Promise.resolve();

      // Neither transport read a byte from the rejected peer...
      expect(directStream.reads).toBe(0);
      expect(pooledStream.reads).toBe(0);
      expect(directStream.sent).toBeNull();
      expect(pooledStream.sent).toBeNull();
      expect(directStream.aborted).not.toBeNull();
      expect(pooledStream.aborted).not.toBeNull();
      // ...and the probing admission check never ran.
      expect(ensureAdmittedSpy).not.toHaveBeenCalled();
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 20000);

  it('routes an unclassified peer through the full probing admission check', async () => {
    // The other half of the production wiring — and the reviewer's exact
    // sabotage scenario: if the factory's `isPeerAccepted` were disconnected
    // (say, `async () => true`), the cached-gate test above stays green
    // because it expects ZERO probes. This proves an unclassified peer's
    // inbound request reaches the REAL coordinator's `ensureAdmitted` after
    // the body read (read-then-probe preserved).
    const networkId = await computeNetworkId(DEFAULT_GENESIS_ID);
    const agent = await DKGAgent.create({
      name: 'AdmissionRouterWiringUnclassified',
      listenPort: 0,
      store: new OxigraphStore(),
      networkIdentity: {
        genesisId: DEFAULT_GENESIS_ID,
        networkId,
        chainId: 'chain:1',
      },
    });
    const captured = new Map<
      string,
      (stream: unknown, connection: unknown) => unknown
    >();
    const realNodeStart = agent.node.start.bind(agent.node);
    (agent.node as unknown as { start: () => Promise<void> }).start = async () => {
      await realNodeStart();
      const lp = agent.node.libp2p as unknown as {
        handle: (protocol: string, handler: (stream: unknown, connection: unknown) => unknown, opts?: unknown) => unknown;
      };
      const realHandle = lp.handle.bind(lp);
      lp.handle = (protocol, handler, opts) => {
        captured.set(protocol, handler);
        return realHandle(protocol, handler, opts);
      };
    };

    try {
      await agent.start();
      expect(captured.has(PROTOCOL_SYNC)).toBe(true);

      // NOT quarantined — an unclassified peer. Mock the coordinator's probe
      // (it would otherwise attempt real network I/O toward a peer that does
      // not exist); the assertion is that the lifecycle wiring REACHES it.
      const coordinator = (
        agent as unknown as { networkAdmissionCoordinator: { ensureAdmitted: (...args: unknown[]) => Promise<boolean> } }
      ).networkAdmissionCoordinator;
      const ensureAdmittedSpy = vi
        .spyOn(coordinator, 'ensureAdmitted')
        .mockResolvedValue(false);

      const stream = new CountingInboundStream();
      await captured.get(PROTOCOL_SYNC)!(stream, {
        remotePeer: {
          toString: () => REJECTED_PEER,
          toMultihash: () => ({ bytes: new Uint8Array([1, 2, 3]) }),
        },
      });

      // Read happened first (unclassified keeps read-then-probe)...
      expect(stream.reads).toBeGreaterThan(0);
      // ...then the REAL coordinator was consulted, and its refusal aborted
      // the stream without a response.
      expect(ensureAdmittedSpy).toHaveBeenCalledTimes(1);
      expect(ensureAdmittedSpy.mock.calls[0][0]).toBe(REJECTED_PEER);
      expect(stream.sent).toBeNull();
      expect(stream.aborted).not.toBeNull();
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 20000);
});

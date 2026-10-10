/**
 * GH#3081 — the agent's side of catalog head delivery: the hand-off a catalog mutation makes, the
 * lanes a fan-out's own policy reads take, and what a finished fan-out writes to the log.
 */
import {
  activeRpcRequestAbortSignal,
  activeRpcRequestContext,
  withRpcRequestContext,
} from '@origintrail-official/dkg-chain';
import {
  activeDefaultStoreWorkPriority,
  withDefaultStoreWorkPriority,
} from '@origintrail-official/dkg-storage';
import { describe, expect, it, vi } from 'vitest';

import { Rfc64SwmCatalogProjectionMethods } from '../src/dkg-agent-rfc64-swm-catalog-projection.js';
import { Rfc64CatalogUpsertMethods } from '../src/dkg-agent-rfc64-catalog-upsert.js';
import type { Rfc64CatalogHeadDeliveryOutcomeV1 } from '../src/rfc64/public-catalog-head-delivery-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from '../src/rfc64/public-catalog-transport-v1.js';

const PEER_A = '12D3KooWAUCFb3hwTLUu3bhMqAsqtF1YH1sTUaMuTXiyvC1z7k65';
const PEER_B = '12D3KooWM72VdeDJFRRhrm9LKLYPrDyQjomVtccJuV8WXYG7uBUU';
const ANNOUNCEMENT = {
  kind: 'rfc64-author-catalog-head-availability-v1',
  networkId: 'otp:20430',
  contextGraphId: '0x1111111111111111111111111111111111111111/lane',
  subGraphName: null,
  authorAddress: `0x${'a1'.repeat(20)}`,
  catalogEra: '0',
  catalogVersion: '7',
  policyDigest: `0x${'2e'.repeat(32)}`,
  catalogHeadObjectDigest: `0x${'aa'.repeat(32)}`,
  signatureVariantDigest: `0x${'bb'.repeat(32)}`,
} as Rfc64PublicCatalogHeadAnnouncementV1;

function agentWith(service: unknown) {
  const debug = vi.fn();
  const warn = vi.fn();
  const agent = Object.assign(Object.create(Rfc64SwmCatalogProjectionMethods.prototype), {
    log: { debug, warn },
    warnRfc64CatalogAnnounceFailuresV1:
      Rfc64CatalogUpsertMethods.prototype.warnRfc64CatalogAnnounceFailuresV1,
  });
  Object.defineProperty(agent, 'rfc64PublicCatalogServiceV1', { get: () => service });
  return { agent, debug, warn };
}

function outcome(
  overrides: Partial<Rfc64CatalogHeadDeliveryOutcomeV1> = {},
): Rfc64CatalogHeadDeliveryOutcomeV1 {
  return {
    announcement: ANNOUNCEMENT,
    announcedPeers: [],
    failedPeers: [],
    refusedPeers: [],
    supersededHeads: 0,
    durationMs: 12.4,
    notDeliverable: null,
    ...overrides,
  };
}

describe('RFC-64 catalog head delivery: agent hand-off', () => {
  it('hands a committed head to the catalog service and returns its receipt', () => {
    const receipt = { status: 'queued', announcement: ANNOUNCEMENT, announcedPeers: [], failedPeers: [] };
    const deliverCatalogHead = vi.fn(() => receipt);
    const { agent } = agentWith({ deliverCatalogHead });

    expect(agent.deliverRfc64CatalogHeadV1({ announcement: ANNOUNCEMENT, peers: [PEER_A] })).toBe(receipt);
    expect(deliverCatalogHead).toHaveBeenCalledWith({ announcement: ANNOUNCEMENT, peers: [PEER_A] });
  });

  it('never throws without a running service: the head is simply not queued', async () => {
    const { agent } = agentWith(undefined);

    expect(agent.deliverRfc64CatalogHeadV1({ announcement: ANNOUNCEMENT, peers: [PEER_A] })).toEqual({
      status: 'not-queued',
      announcement: ANNOUNCEMENT,
      announcedPeers: [],
      failedPeers: [],
    });
    await expect(agent.whenRfc64CatalogHeadDeliveryIdleV1()).resolves.toBeUndefined();
  });

  it('waits for the service\'s fan-outs when asked to', async () => {
    let release!: () => void;
    const idle = new Promise<void>((resolve) => { release = resolve; });
    const { agent } = agentWith({ whenCatalogHeadDeliveryIdle: () => idle });
    let settled = false;

    const waiting = agent.whenRfc64CatalogHeadDeliveryIdleV1().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await waiting;
    expect(settled).toBe(true);
  });
});

describe('RFC-64 catalog head delivery: lanes of a fan-out', () => {
  it('runs a fan-out on the background store lane and RPC class, without the caller\'s cancellation', async () => {
    const { agent } = agentWith(undefined);
    const ports = agent.rfc64CatalogHeadDeliveryPortsV1();
    const caller = new AbortController();
    let seen: unknown;

    await withDefaultStoreWorkPriority('normal', () => withRpcRequestContext(
      { requestClass: 'foreground', signal: caller.signal },
      () => ports.runFanout!(async () => {
        seen = {
          storeLane: activeDefaultStoreWorkPriority(),
          rpcClass: activeRpcRequestContext().requestClass,
          rpcSignal: activeRpcRequestAbortSignal(),
        };
      }),
    ));

    expect(seen).toEqual({ storeLane: 'background', rpcClass: 'background', rpcSignal: undefined });
  });

  it('routes a finished fan-out to the log', () => {
    const { agent, debug } = agentWith(undefined);

    agent.rfc64CatalogHeadDeliveryPortsV1().onDelivered!(outcome({ announcedPeers: [PEER_A] }));

    expect(debug).toHaveBeenCalledOnce();
  });
});

describe('RFC-64 catalog head delivery: what a finished fan-out logs', () => {
  it('writes nothing at warn level for a head with no eligible peer', () => {
    const { agent, debug, warn } = agentWith(undefined);

    agent.reportRfc64CatalogHeadDeliveryV1(outcome({ refusedPeers: [PEER_A, PEER_B] }));

    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledOnce();
    expect(debug.mock.calls[0]![1]).toBe(
      'rfc64_catalog_head_delivery'
      + ` head=${ANNOUNCEMENT.catalogHeadObjectDigest}`
      + ` cg=${ANNOUNCEMENT.contextGraphId}`
      + ' version=7 delivered=0 failed=0 refused=2 superseded=0 durationMs=12 notDeliverable=null',
    );
  });

  it('warns about failed deliveries only, counted among the peers that were eligible', () => {
    const { agent, debug, warn } = agentWith(undefined);

    agent.reportRfc64CatalogHeadDeliveryV1(outcome({
      announcedPeers: [PEER_A],
      failedPeers: [{ peerId: PEER_B, error: 'stream reset by peer' }],
      refusedPeers: ['outsider-1', 'outsider-2', 'outsider-3'],
      supersededHeads: 2,
    }));

    expect(warn).toHaveBeenCalledOnce();
    const message = String(warn.mock.calls[0]![1]);
    // One of the two eligible peers failed; the three refused peers are in neither number.
    expect(message).toContain('RFC-64 catalog head announce failed for 1/2 peer(s)');
    expect(message).toContain(`peers=${PEER_B.slice(-8)}`);
    expect(message).toContain('error=stream reset by peer');
    expect(message).not.toContain('outsider');
    expect(String(debug.mock.calls[0]![1])).toContain('delivered=1 failed=1 refused=3 superseded=2');
  });

  it('reports a head that could not be fanned out at debug level only', () => {
    const { agent, debug, warn } = agentWith(undefined);

    agent.reportRfc64CatalogHeadDeliveryV1(outcome({
      notDeliverable: 'RFC-64 catalog announcement is not bound to the locally accepted policy snapshot',
    }));

    expect(warn).not.toHaveBeenCalled();
    expect(String(debug.mock.calls[0]![1])).toContain(
      'notDeliverable="RFC-64 catalog announcement is not bound to the locally accepted policy snapshot"',
    );
  });
});

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
import {
  CATALOG_HEAD_DELIVERY_LOG_WINDOW_MS,
  CatalogHeadDeliveryReportV1,
  installCatalogHeadDeliveryReportV1,
} from '../src/internal/catalog-head-delivery-report.js';
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
  const info = vi.fn();
  const warn = vi.fn();
  const agent = Object.assign(Object.create(Rfc64SwmCatalogProjectionMethods.prototype), {
    log: { debug, info, warn },
    warnRfc64CatalogAnnounceFailuresV1:
      Rfc64CatalogUpsertMethods.prototype.warnRfc64CatalogAnnounceFailuresV1,
  });
  Object.defineProperty(agent, 'rfc64PublicCatalogServiceV1', { get: () => service });
  return { agent, debug, info, warn };
}

function outcome(
  overrides: Partial<Rfc64CatalogHeadDeliveryOutcomeV1> = {},
): Rfc64CatalogHeadDeliveryOutcomeV1 {
  return {
    announcement: ANNOUNCEMENT,
    announcedPeers: [],
    failedPeers: [],
    refusedPeers: [],
    uncheckedPeers: [],
    unconfirmedPeers: [],
    supersededHeads: 0,
    checkpointCapacityExceeded: false,
    durationMs: 12.4,
    notDeliverable: null,
    ...overrides,
  };
}

const HEAD = ` head=${ANNOUNCEMENT.catalogHeadObjectDigest} cg=${ANNOUNCEMENT.contextGraphId} version=7`;
const messages = (log: ReturnType<typeof vi.fn>): string[] => log.mock.calls.map(([, message]) => String(message));

describe('RFC-64 catalog head delivery: agent hand-off', () => {
  it('hands a committed head to the catalog service and returns its receipt', () => {
    const receipt = { status: 'queued' };
    const deliverCatalogHead = vi.fn(() => receipt);
    const { agent, info, warn } = agentWith({ deliverCatalogHead });

    expect(agent.deliverRfc64CatalogHeadV1({ announcement: ANNOUNCEMENT, peers: [PEER_A] })).toBe(receipt);
    expect(deliverCatalogHead).toHaveBeenCalledWith({ announcement: ANNOUNCEMENT, peers: [PEER_A] });
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws without a running service: the head is not queued, and a line says so', async () => {
    const { agent, info, warn } = agentWith(undefined);

    expect(agent.deliverRfc64CatalogHeadV1({ announcement: ANNOUNCEMENT, peers: [PEER_A] }))
      .toEqual({ status: 'not-queued', reason: 'unavailable' });
    expect(messages(info)).toEqual([
      `RFC-64 catalog head was not queued for delivery${HEAD} reason=unavailable`,
    ]);
    expect(warn).not.toHaveBeenCalled();
    await expect(agent.whenRfc64CatalogHeadDeliveryIdleV1()).resolves.toBeUndefined();
  });

  it('writes a hand-off that was not queued at warn when the node itself is the reason', () => {
    for (const [reason, level] of [
      ['closed', 'info'], ['full', 'warn'], ['invalid', 'warn'],
    ] as const) {
      const { agent, info, warn } = agentWith({
        deliverCatalogHead: () => ({ status: 'not-queued', reason }),
      });

      agent.deliverRfc64CatalogHeadV1({ announcement: ANNOUNCEMENT, peers: [PEER_A] });

      const line = `RFC-64 catalog head was not queued for delivery${HEAD} reason=${reason}`;
      expect(messages(level === 'info' ? info : warn)).toEqual([line]);
      expect(level === 'info' ? warn : info).not.toHaveBeenCalled();
    }
    // A malformed hand-off is reported the same way and still does not throw.
    const { agent, warn } = agentWith({ deliverCatalogHead: () => ({ status: 'not-queued', reason: 'invalid' }) });
    expect(() => agent.deliverRfc64CatalogHeadV1(undefined as never)).not.toThrow();
    expect(messages(warn)[0]).toContain('reason=invalid');
  });

  it('writes one line a minute for a reason, and the next one says how many it stands for', () => {
    const clock = { now: 0 };
    const { agent, warn } = agentWith({ deliverCatalogHead: () => ({ status: 'not-queued', reason: 'full' }) });
    installCatalogHeadDeliveryReportV1(agent, new CatalogHeadDeliveryReportV1(() => clock.now));
    const handOff = (): unknown => agent.deliverRfc64CatalogHeadV1({ announcement: ANNOUNCEMENT, peers: [PEER_A] });

    handOff();
    clock.now = CATALOG_HEAD_DELIVERY_LOG_WINDOW_MS - 1;
    handOff();
    handOff();
    expect(warn).toHaveBeenCalledOnce();

    clock.now = CATALOG_HEAD_DELIVERY_LOG_WINDOW_MS;
    handOff();
    expect(messages(warn)).toEqual([
      `RFC-64 catalog head was not queued for delivery${HEAD} reason=full`,
      `RFC-64 catalog head was not queued for delivery${HEAD} reason=full`
      + ' (and 2 more like it since the last line)',
    ]);
  });

  it('says so when a mutation does not hand its head off because its caller gave up during the commit', async () => {
    const info = vi.fn();
    const handedOff: unknown[] = [];
    const applied = { catalogVersion: ANNOUNCEMENT.catalogVersion };
    const mutation = (signal: AbortSignal, onCommitted: () => void) => {
      const agent = Object.assign(Object.create(Rfc64CatalogUpsertMethods.prototype), {
        log: { debug: vi.fn(), info, warn: vi.fn() },
        publishAuthorCatalogExactSetSuccessorV1: async () => ({
          catalogScopeDigest: `0x${'cc'.repeat(32)}`,
          headObjectDigest: ANNOUNCEMENT.catalogHeadObjectDigest,
          announcement: ANNOUNCEMENT,
          signedBucketRowCount: '0',
          assets: [],
        }),
        deliverRfc64CatalogHeadV1: (input: unknown) => {
          handedOff.push(input);
          return { status: 'queued' };
        },
        reportRfc64CatalogHeadNotHandedOffV1:
          Rfc64SwmCatalogProjectionMethods.prototype.reportRfc64CatalogHeadNotHandedOffV1,
      });
      return agent.applyRfc64CatalogSuccessorV1(
        { inventory: { compareAndSwapAppliedCatalogHeadV1: () => ({ snapshot: applied }) } },
        { previousHead: null, catalogIssuerAuthorization: {}, expectedCurrentCatalogHeadDigest: null },
        { scope: { authorAddress: ANNOUNCEMENT.authorAddress }, author: {}, deployment: {} },
        [],
        [PEER_A],
        false,
        {
          signal,
          commitAppliedHead: async (commit: () => unknown) => {
            const appliedHead = commit();
            onCommitted();
            return { appliedHead, sourceCurrent: true };
          },
        },
      );
    };

    // A caller that is still there: the committed head is handed off, and nothing is logged.
    await expect(mutation(new AbortController().signal, () => undefined))
      .resolves.toMatchObject({ applied });
    expect(handedOff).toEqual([{ announcement: ANNOUNCEMENT, peers: [PEER_A] }]);
    expect(info).not.toHaveBeenCalled();

    // The head becomes durable, and only then does the caller give up.
    const caller = new AbortController();
    await expect(mutation(caller.signal, () => caller.abort(new Error('caller gave up'))))
      .resolves.toMatchObject({ applied });
    expect(handedOff).toHaveLength(1);
    expect(messages(info)).toEqual([
      `RFC-64 catalog head was not queued for delivery${HEAD} reason=cancelled`,
    ]);
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
  it('writes nothing above debug level for a head with no eligible peer', () => {
    const { agent, debug, info, warn } = agentWith(undefined);

    agent.reportRfc64CatalogHeadDeliveryV1(outcome({ refusedPeers: [PEER_A, PEER_B] }));

    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(messages(debug)).toEqual([
      `rfc64_catalog_head_delivery${HEAD} delivered=0 failed=0 refused=2 unchecked=0 unconfirmed=0`
      + ' superseded=0 checkpointCapacityExceeded=false durationMs=12 notDeliverable=null',
    ]);
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
    const message = messages(warn)[0]!;
    // One of the two eligible peers failed; the three refused peers are in neither number.
    expect(message).toContain('RFC-64 catalog head announce failed for 1/2 peer(s)');
    expect(message).toContain(`peers=${PEER_B.slice(-8)}`);
    expect(message).toContain('error=stream reset by peer');
    expect(message).not.toContain('outsider');
    expect(messages(debug)[0]).toContain('delivered=1 failed=1 refused=3 unchecked=0 unconfirmed=0 superseded=2');
  });

  it('warns when this node could not check peers: that is not a head with nobody to deliver to', () => {
    const { agent, debug, warn } = agentWith(undefined);
    const everyone = Array.from({ length: 11 }, (_, index) => `peer-${index}`);

    agent.reportRfc64CatalogHeadDeliveryV1(outcome({ uncheckedPeers: everyone }));

    expect(messages(warn)).toEqual([
      `RFC-64 catalog head delivery could not check 11/11 peer(s)${HEAD}:`
      + ' this node\'s policy check did not answer for them, so they were sent nothing',
    ]);
    expect(messages(debug)[0]).toContain('delivered=0 failed=0 refused=0 unchecked=11 unconfirmed=0');
  });

  it('counts unchecked peers among all the peers named, and warns once a minute for a catalog', () => {
    const clock = { now: 0 };
    const { agent, warn } = agentWith(undefined);
    installCatalogHeadDeliveryReportV1(agent, new CatalogHeadDeliveryReportV1(() => clock.now));
    const report = (): void => agent.reportRfc64CatalogHeadDeliveryV1(outcome({
      announcedPeers: [PEER_A],
      refusedPeers: ['outsider-1', 'outsider-2'],
      uncheckedPeers: [PEER_B],
    }));

    report();
    report();
    clock.now = CATALOG_HEAD_DELIVERY_LOG_WINDOW_MS;
    report();

    expect(messages(warn)).toEqual([
      `RFC-64 catalog head delivery could not check 1/4 peer(s)${HEAD}:`
      + ' this node\'s policy check did not answer for them, so they were sent nothing',
      `RFC-64 catalog head delivery could not check 1/4 peer(s)${HEAD}:`
      + ' this node\'s policy check did not answer for them, so they were sent nothing'
      + ' (and 1 more like it since the last line)',
    ]);
  });

  it('says when a head went to a peer whose authorization could not be confirmed afterwards', () => {
    const { agent, debug, info, warn } = agentWith(undefined);

    agent.reportRfc64CatalogHeadDeliveryV1(outcome({
      announcedPeers: [PEER_A],
      unconfirmedPeers: [PEER_B],
    }));

    expect(warn).not.toHaveBeenCalled();
    expect(messages(info)).toEqual([
      'RFC-64 catalog head was sent to 1 peer(s) whose authorization could not be confirmed once'
      + ` the send had finished${HEAD} peers=${PEER_B.slice(-8)}`,
    ]);
    expect(messages(debug)[0]).toContain('delivered=1 failed=0 refused=0 unchecked=0 unconfirmed=1');
  });

  it('warns when a delivery had to give up a waiting head it should have kept', () => {
    const { agent, debug, warn } = agentWith(undefined);

    agent.reportRfc64CatalogHeadDeliveryV1(outcome({
      announcedPeers: [PEER_A],
      supersededHeads: 70_000,
      checkpointCapacityExceeded: true,
    }));

    expect(messages(warn)).toEqual([
      `RFC-64 catalog head delivery could not keep a waiting head${HEAD}:`
      + ' peers named for it may have been left out, and a peer more than a lineage window'
      + ' behind the newest head cannot apply it',
    ]);
    expect(messages(debug)[0]).toContain('superseded=70000 checkpointCapacityExceeded=true');
  });

  it('says at info level when a head could not be fanned out at all', () => {
    const { agent, debug, info, warn } = agentWith(undefined);
    const reason = 'RFC-64 catalog announcement is not bound to the locally accepted policy snapshot';

    agent.reportRfc64CatalogHeadDeliveryV1(outcome({ notDeliverable: reason }));

    expect(warn).not.toHaveBeenCalled();
    expect(messages(info)).toEqual([`RFC-64 catalog head was not fanned out${HEAD}: ${reason}`]);
    expect(messages(debug)[0]).toContain(`notDeliverable="${reason}"`);
  });

  it('never lets a report fail the delivery that made it', () => {
    const { agent } = agentWith(undefined);
    agent.log.debug = () => { throw new Error('log sink closed'); };

    expect(() => agent.reportRfc64CatalogHeadDeliveryV1(outcome({ uncheckedPeers: [PEER_A] }))).not.toThrow();
  });
});

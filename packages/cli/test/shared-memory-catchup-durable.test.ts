import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '', headers: {} as Record<string, string>, writableEnded: false };
  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res.statusCode = status;
    if (headers) Object.assign(res.headers, headers);
  };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.end = (body: string) => {
    res.body = body;
    res.writableEnded = true;
  };
  return res;
}

function fakeReq(body: unknown) {
  return {
    method: 'POST',
    headers: {},
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)),
  } as any;
}

function buildCatchupCtx(body: unknown, agent: Record<string, any>) {
  const res = fakeRes();
  const url = new URL('http://127.0.0.1/api/shared-memory/catchup');
  const ctx = {
    req: fakeReq(body),
    res,
    agent,
    path: url.pathname,
    url,
  } as unknown as RequestContext;
  return { ctx, res };
}

describe('POST /api/shared-memory/catchup durable leg', () => {
  it('still runs includeDurable when SWM is not currently usable for the CG', async () => {
    const syncSharedMemoryFromPeerDetailed = vi.fn();
    const syncSharedMemoryFromPeer = vi.fn();
    const syncFromPeer = vi.fn(async () => 7);
    const agent = {
      peerId: 'self-peer',
      canUseSharedMemoryForContextGraph: vi.fn(async () => false),
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
      syncSharedMemoryFromPeerDetailed,
      syncSharedMemoryFromPeer,
      syncFromPeer,
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'review-cg',
        peerId: 'peer-a',
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(syncSharedMemoryFromPeerDetailed).not.toHaveBeenCalled();
    expect(syncSharedMemoryFromPeer).not.toHaveBeenCalled();
    expect(syncFromPeer).toHaveBeenCalledTimes(1);
    expect(syncFromPeer).toHaveBeenCalledWith('peer-a', ['review-cg']);

    const body = JSON.parse(res.body);
    expect(body.totalInsertedTriples).toBe(0);
    expect(body.totalDurableInsertedTriples).toBe(7);
    expect(body.peersAttempted).toBe(1);
    expect(body.perContextGraph).toEqual([
      {
        contextGraphId: 'review-cg',
        insertedTriples: 0,
        durableInsertedTriples: 7,
        perPeer: [
          {
            peerId: 'peer-a',
            insertedTriples: 0,
            durableInsertedTriples: 7,
          },
        ],
      },
    ]);
  });

  it('filters route-selected SWM catchup peers by current protocol and private curator scope', async () => {
    const cgId = 'private-route-cg';
    const curatorPeer = 'peer-curator';
    const nonCuratorPeer = 'peer-non-curator';
    const legacyPeer = 'peer-legacy';
    const syncSharedMemoryFromPeerDetailed = vi.fn(async () => ({ insertedTriples: 5 }));
    const syncFromPeer = vi.fn();
    const agent = {
      peerId: 'self-peer',
      node: {
        libp2p: {
          getConnections: () => [curatorPeer, nonCuratorPeer, legacyPeer].map((peerId) => ({
            remotePeer: { toString: () => peerId },
          })),
        },
      },
      canUseSharedMemoryForContextGraph: vi.fn(async () => true),
      getPeerProtocols: vi.fn(async (peerId: string) => (
        peerId === legacyPeer ? ['/dkg/10.0.1/sync'] : [PROTOCOL_SYNC]
      )),
      isPrivateContextGraph: vi.fn(async () => true),
      resolveCuratorPeerIdsForCg: vi.fn(async () => ({
        curatorIsLocal: false,
        peerIds: [curatorPeer],
      })),
      syncSharedMemoryFromPeerDetailed,
      syncFromPeer,
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: cgId,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(syncSharedMemoryFromPeerDetailed).toHaveBeenCalledTimes(1);
    expect(syncSharedMemoryFromPeerDetailed).toHaveBeenCalledWith(curatorPeer, [cgId]);
    expect(syncFromPeer).not.toHaveBeenCalled();

    const body = JSON.parse(res.body);
    expect(body.peersAttempted).toBe(1);
    expect(body.results).toEqual([
      {
        peerId: curatorPeer,
        insertedTriples: 5,
        durableInsertedTriples: 0,
      },
    ]);
    expect(body.perContextGraph).toEqual([
      {
        contextGraphId: cgId,
        insertedTriples: 5,
        durableInsertedTriples: 0,
        perPeer: [
          {
            peerId: curatorPeer,
            insertedTriples: 5,
            durableInsertedTriples: 0,
          },
        ],
      },
    ]);
  });

  it('keeps includeDurable independent from the SWM negative outcome cache', async () => {
    const cgId = 'public-negative-cache-route-cg';
    const negativePeer = 'peer-negative-cache';
    const unknownPeer = 'peer-unknown-cache';
    let connectedPeers = [negativePeer];
    const syncSharedMemoryFromPeerDetailed = vi.fn(async () => ({ insertedTriples: 0 }));
    const syncFromPeer = vi.fn(async (peerId: string) => (peerId === negativePeer ? 11 : 13));
    const agent = {
      peerId: 'self-peer',
      node: {
        libp2p: {
          getConnections: () => connectedPeers.map((peerId) => ({
            remotePeer: { toString: () => peerId },
          })),
        },
      },
      canUseSharedMemoryForContextGraph: vi.fn(async () => true),
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
      syncSharedMemoryFromPeerDetailed,
      syncFromPeer,
    };

    const first = buildCatchupCtx(
      {
        contextGraphId: cgId,
        peerId: negativePeer,
        hostCatchupFallback: false,
      },
      agent,
    );
    await handleMemoryRoutes(first.ctx);
    expect(first.res.statusCode).toBe(200);
    expect(syncSharedMemoryFromPeerDetailed).toHaveBeenCalledWith(negativePeer, [cgId]);
    expect(syncFromPeer).not.toHaveBeenCalled();

    syncSharedMemoryFromPeerDetailed.mockClear();
    syncFromPeer.mockClear();
    connectedPeers = [negativePeer, unknownPeer];
    const second = buildCatchupCtx(
      {
        contextGraphId: cgId,
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );
    await handleMemoryRoutes(second.ctx);

    expect(second.res.statusCode).toBe(200);
    expect(syncSharedMemoryFromPeerDetailed).toHaveBeenCalledTimes(1);
    expect(syncSharedMemoryFromPeerDetailed).toHaveBeenCalledWith(unknownPeer, [cgId]);
    expect(syncFromPeer.mock.calls.map(([peerId]) => peerId).sort()).toEqual([
      negativePeer,
      unknownPeer,
    ].sort());
    expect(syncFromPeer).toHaveBeenCalledWith(negativePeer, [cgId]);
    expect(syncFromPeer).toHaveBeenCalledWith(unknownPeer, [cgId]);

    const body = JSON.parse(second.res.body);
    expect(body.peersAttempted).toBe(2);
    expect(body.totalDurableInsertedTriples).toBe(24);
    expect(body.perContextGraph).toEqual([
      {
        contextGraphId: cgId,
        insertedTriples: 0,
        durableInsertedTriples: 24,
        perPeer: expect.arrayContaining([
          {
            peerId: negativePeer,
            insertedTriples: 0,
            durableInsertedTriples: 11,
          },
          {
            peerId: unknownPeer,
            insertedTriples: 0,
            durableInsertedTriples: 13,
          },
        ]),
      },
    ]);
  });
});

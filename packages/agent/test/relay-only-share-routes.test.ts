// SPDX-License-Identifier: Apache-2.0

/**
 * The two routes by which a share into a public graph reaches the nodes that
 * need it when its author connects only to Cores (`swm/relay-only-share-routes.ts`):
 * a Core that hosts the graph applies a share into a named sub-graph, and the
 * author makes the graph's owner one of the share's followers. The agent's
 * wiring is in `swm-shares-through-relay.test.ts` and
 * `core-hosted-sub-graph-share.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GRAPH_OWNER_PEERS_TTL_MS,
  GRAPH_OWNER_RETRY_AFTER_MS,
  GraphOwnerPeers,
  coreHostsPublicGraph,
  routeShareToGraphOwner,
  type GraphOwnerRoutePorts,
} from '../src/swm/relay-only-share-routes.js';

const GRAPH = '0x1111111111111111111111111111111111111111/relay-only';
const OWNER_1 = '12D3KooWOwnerNodeOne';
const OWNER_2 = '12D3KooWOwnerNodeTwo';
const OWNER_3 = '12D3KooWOwnerNodeThree';

describe('a Core that hosts a public graph', () => {
  it('is a Core whose subscription row records the graph as hosted', () => {
    expect(coreHostsPublicGraph('core', { coreHosted: true })).toBe(true);
  });

  it('is not an Edge, a Core that does not host the graph, or a node without the row', () => {
    expect(coreHostsPublicGraph('edge', { coreHosted: true })).toBe(false);
    expect(coreHostsPublicGraph(undefined, { coreHosted: true })).toBe(false);
    expect(coreHostsPublicGraph('core', { coreHosted: false })).toBe(false);
    expect(coreHostsPublicGraph('core', {})).toBe(false);
    expect(coreHostsPublicGraph('core', undefined)).toBe(false);
  });
});

describe('the route of a share to the graph\'s owner', () => {
  function ports(options: {
    owners?: readonly string[];
    connected?: readonly string[];
    reachable?: readonly string[];
    ownersFail?: boolean;
    failed?: readonly string[];
  } = {}) {
    const connected = new Set(options.connected ?? []);
    const followers: Array<[string, string]> = [];
    const connects: string[] = [];
    const failed = new Set<string>(options.failed ?? []);
    const route: GraphOwnerRoutePorts = {
      ownerPeerIds: async () => {
        if (options.ownersFail) throw new Error('registry unavailable');
        return options.owners ?? [OWNER_1];
      },
      isConnected: (peerId) => connected.has(peerId),
      connect: async (peerId, signal) => {
        connects.push(peerId);
        expect(signal.aborted).toBe(false);
        if (!(options.reachable ?? []).includes(peerId)) throw new Error('no route');
        connected.add(peerId);
        return true;
      },
      mayConnect: (peerId) => !failed.has(peerId),
      connectFailed: (peerId) => { failed.add(peerId); },
      noteFollower: (contextGraphId, peerId) => { followers.push([contextGraphId, peerId]); },
    };
    return { route, followers, connects, failed };
  }

  it('makes a connected owner a follower without connecting again', async () => {
    const { route, followers, connects } = ports({ owners: [OWNER_1, OWNER_2], connected: [OWNER_2] });

    await expect(routeShareToGraphOwner(route, GRAPH)).resolves.toEqual([OWNER_2]);
    expect(followers).toEqual([[GRAPH, OWNER_2]]);
    expect(connects).toEqual([]);
  });

  it('connects to an owner that is not connected, and makes it a follower', async () => {
    const { route, followers, connects } = ports({ reachable: [OWNER_1] });

    await expect(routeShareToGraphOwner(route, GRAPH)).resolves.toEqual([OWNER_1]);
    expect(connects).toEqual([OWNER_1]);
    expect(followers).toEqual([[GRAPH, OWNER_1]]);
  });

  it('tries the next of the owner\'s peers when one cannot be reached, up to the bound', async () => {
    const second = ports({ owners: [OWNER_1, OWNER_2, OWNER_3], reachable: [OWNER_2] });
    await expect(routeShareToGraphOwner(second.route, GRAPH)).resolves.toEqual([OWNER_2]);
    expect(second.connects).toEqual([OWNER_1, OWNER_2]);

    const none = ports({ owners: [OWNER_1, OWNER_2, OWNER_3], reachable: [OWNER_3] });
    await expect(routeShareToGraphOwner(none.route, GRAPH)).resolves.toEqual([]);
    expect(none.connects).toEqual([OWNER_1, OWNER_2]);
    expect(none.followers).toEqual([]);
    expect([...none.failed]).toEqual([OWNER_1, OWNER_2]);
  });

  it('does not try a peer a connection recently failed to, so that the share does not wait for it', async () => {
    const { route, connects, followers } = ports({ owners: [OWNER_1, OWNER_2], reachable: [OWNER_1, OWNER_2], failed: [OWNER_1] });

    await expect(routeShareToGraphOwner(route, GRAPH)).resolves.toEqual([OWNER_2]);
    expect(connects).toEqual([OWNER_2]);
    expect(followers).toEqual([[GRAPH, OWNER_2]]);
  });

  it('counts a peer that does not take shares as not reached', async () => {
    const { route, followers } = ports();
    route.connect = async () => false;

    await expect(routeShareToGraphOwner(route, GRAPH)).resolves.toEqual([]);
    expect(followers).toEqual([]);
  });

  it('gives up on a connection that does not finish within the bound', async () => {
    const { route, followers } = ports();
    route.connect = (_peerId, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    });

    await expect(routeShareToGraphOwner(route, GRAPH, { timeoutMs: 5 })).resolves.toEqual([]);
    expect(followers).toEqual([]);
  });

  it('gives up on an owner lookup that does not finish within the bound, before any connection', async () => {
    const { route, followers, connects } = ports();
    let lookupSignal: AbortSignal | undefined;
    route.ownerPeerIds = (_contextGraphId, signal) => {
      lookupSignal = signal;
      return new Promise(() => {});
    };

    await expect(routeShareToGraphOwner(route, GRAPH, { timeoutMs: 5 })).resolves.toEqual([]);
    expect(lookupSignal?.aborted).toBe(true);
    expect(connects).toEqual([]);
    expect(followers).toEqual([]);
  });

  it('does nothing for a graph this node owns, or when the owner cannot be looked up', async () => {
    const owned = ports({ owners: [] });
    const failing = ports({ ownersFail: true });

    await expect(routeShareToGraphOwner(owned.route, GRAPH)).resolves.toEqual([]);
    await expect(routeShareToGraphOwner(failing.route, GRAPH)).resolves.toEqual([]);
    expect([...owned.connects, ...failing.connects]).toEqual([]);
    expect([...owned.followers, ...failing.followers]).toEqual([]);
  });
});

describe('the owner peers of a graph', () => {
  it('are looked up once per graph within the window, a failed lookup included', async () => {
    let now = 0;
    const resolve = vi.fn(async (contextGraphId: string) => {
      if (contextGraphId === 'failing') throw new Error('registry unavailable');
      return [OWNER_1];
    });
    const owners = new GraphOwnerPeers(resolve, () => now);

    await expect(owners.of(GRAPH)).resolves.toEqual([OWNER_1]);
    await expect(owners.of(GRAPH)).resolves.toEqual([OWNER_1]);
    await expect(owners.of('failing')).resolves.toEqual([]);
    await expect(owners.of('failing')).resolves.toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(2);

    now += GRAPH_OWNER_PEERS_TTL_MS;
    await owners.of(GRAPH);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('do not remember a lookup the caller gave up on', async () => {
    let calls = 0;
    const owners = new GraphOwnerPeers(async (_contextGraphId, signal) => {
      calls += 1;
      if (signal?.aborted) throw new Error('lookup aborted');
      return [OWNER_1];
    }, () => 0);
    const gaveUp = new AbortController();
    gaveUp.abort();

    await expect(owners.of(GRAPH, gaveUp.signal)).rejects.toThrow('lookup aborted');
    await expect(owners.of(GRAPH)).resolves.toEqual([OWNER_1]);
    expect(calls).toBe(2);
  });

  it('let a peer a connection failed to be tried again after the pause', () => {
    let now = 0;
    const owners = new GraphOwnerPeers(async () => [OWNER_1], () => now);
    expect(owners.mayConnect(OWNER_1)).toBe(true);
    owners.connectFailed(OWNER_1);
    expect(owners.mayConnect(OWNER_1)).toBe(false);
    expect(owners.mayConnect(OWNER_2)).toBe(true);
    now += GRAPH_OWNER_RETRY_AFTER_MS;
    expect(owners.mayConnect(OWNER_1)).toBe(true);
    for (let index = 0; index <= 256; index += 1) owners.connectFailed(`peer-${index}`);
    expect(owners.mayConnect('peer-0')).toBe(true);
    expect(owners.mayConnect('peer-256')).toBe(false);
  });

  it('keep at most 256 graphs and let the oldest go', async () => {
    const resolve = vi.fn(async () => [OWNER_1]);
    const owners = new GraphOwnerPeers(resolve, () => 0);
    for (let index = 0; index <= 256; index += 1) await owners.of(`graph-${index}`);
    expect(resolve).toHaveBeenCalledTimes(257);

    await owners.of('graph-256');
    expect(resolve).toHaveBeenCalledTimes(257);
    await owners.of('graph-0');
    expect(resolve).toHaveBeenCalledTimes(258);
  });
});

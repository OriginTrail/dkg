/**
 * GH#3081 — one owner per catalog scope: a newer head replaces one that was not sent yet, the
 * peers of a replaced head get the head that replaced it, two sent heads stay within what a
 * receiver can prove its way across, and scopes, waiting heads and fan-outs are bounded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1 } from '../src/rfc64/catalog-head-lineage-v1.js';
import { RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 } from '../src/rfc64/catalog-peers-v1.js';
import {
  RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1,
  RFC64_CATALOG_HEAD_DELIVERY_MAX_CHECKPOINTS_V1,
  RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1,
  RFC64_CATALOG_HEAD_DELIVERY_MAX_VERSION_STEP_V1,
  RFC64_CATALOG_HEAD_DELIVERY_MAX_WAITING_HEADS_PER_SCOPE_V1,
} from '../src/rfc64/public-catalog-head-delivery-v1.js';
import {
  AUTHOR,
  BUDGET_MS,
  POLICY_DIGEST,
  author,
  harness,
  head,
  peers,
  settle,
} from './support/rfc64-catalog-head-delivery-harness.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RFC-64 catalog head delivery: one owner per scope, newest head', () => {
  it('replaces a head that was not sent yet with a newer one', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour, mostInFlightByAuthor } = harness();
    behaviour.set('slow-peer', 'stall');

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    expect(sends.map(({ version }) => version)).toEqual(['1']);

    // Three more changes of the scope commit while the first head is still being sent.
    expect(delivery.deliver({ announcement: head('2'), peers: ['slow-peer'] }).status).toBe('queued');
    expect(delivery.deliver({ announcement: head('3'), peers: ['slow-peer'] }).status).toBe('queued');
    expect(delivery.deliver({ announcement: head('4'), peers: ['slow-peer', 'new-peer'] }).status)
      .toBe('queued');
    await settle();
    expect(sends.map(({ version }) => version)).toEqual(['1']);
    expect(delivery.pendingScopes).toBe(1);

    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    // The newest head goes out next, to the peers handed off with it; 2 and 3 are never sent.
    expect(sends.map(({ peerId, version }) => [peerId, version])).toEqual([
      ['slow-peer', '1'],
      ['slow-peer', '4'],
      ['new-peer', '4'],
    ]);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);

    expect(outcomes.map(({ announcement, supersededHeads }) => [
      announcement.catalogVersion,
      supersededHeads,
    ])).toEqual([['1', 0], ['4', 2]]);
    expect(mostInFlightByAuthor.get(AUTHOR)).toBe(2);
    expect(delivery.pendingScopes).toBe(0);
  });

  it('never trades the newest waiting head for an older one handed off late', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('5'), peers: ['slow-peer'] });
    delivery.deliver({ announcement: head('4'), peers: ['slow-peer'] });
    await vi.advanceTimersByTimeAsync(2 * BUDGET_MS);

    expect(sends.map(({ version }) => version)).toEqual(['1', '5']);
    expect(outcomes.map(({ supersededHeads }) => supersededHeads)).toEqual([0, 1]);
  });

  it('sends the newest head to the peers of every head it replaced', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    // Two more changes commit while the first head is being sent, each naming another peer.
    delivery.deliver({ announcement: head('2'), peers: ['peer-a'] });
    delivery.deliver({ announcement: head('3'), peers: ['peer-b'] });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await settle();

    // Version 2 is never sent, but the peer it was meant for gets the head that replaced it.
    expect(sends.map(({ peerId, version }) => [peerId, version])).toEqual([
      ['slow-peer', '1'],
      ['peer-b', '3'],
      ['peer-a', '3'],
    ]);
    expect(outcomes[1]).toMatchObject({ announcedPeers: ['peer-b', 'peer-a'], supersededHeads: 1 });
  });

  it('gives the peers of an older head handed off late the newest head', async () => {
    vi.useFakeTimers();
    const { delivery, sends, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('5'), peers: ['peer-a'] });
    delivery.deliver({ announcement: head('4'), peers: ['peer-b'] });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await settle();

    expect(sends.map(({ peerId, version }) => [peerId, version])).toEqual([
      ['slow-peer', '1'],
      ['peer-a', '5'],
      ['peer-b', '5'],
    ]);
  });

  it('keeps a waiting head for the peers a newer head has no room for', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');
    const earlier = peers(RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1, 'earlier');
    const newest = peers(RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 - 2, 'newest');

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('2'), peers: earlier });
    delivery.deliver({ announcement: head('3'), peers: newest });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await settle();

    // One fan-out addresses 64 peers. The newer head takes its own and the first two of the
    // earlier head's; the earlier head stays for the other 62 and is sent to them first.
    expect(sends.slice(1).map(({ peerId, version }) => [peerId, version])).toEqual([
      ...earlier.slice(2).map((peerId) => [peerId, '2']),
      ...newest.map((peerId) => [peerId, '3']),
      ...earlier.slice(0, 2).map((peerId) => [peerId, '3']),
    ]);
    // No head was replaced, and nothing had to be given up.
    expect(outcomes.slice(1).map((outcome) => [
      outcome.announcement.catalogVersion,
      outcome.supersededHeads,
      outcome.checkpointCapacityExceeded,
    ])).toEqual([['2', 0, false], ['3', 0, false]]);
  });

  it('sends two full peer lists a head each, and a peer the selection dropped the head it was named for', async () => {
    vi.useFakeTimers();
    const { delivery, sends, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');
    const limit = RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1;
    const first = peers(limit, 'first');
    const second = peers(limit, 'second');
    const other = author(1);
    // What a node with more connections than one fan-out addresses hands off: the selection
    // moves by one peer between two changes.
    const connected = peers(limit + 1, 'connected');

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    delivery.deliver({ announcement: head('1', other), peers: ['slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('2'), peers: first });
    delivery.deliver({ announcement: head('3'), peers: second });
    delivery.deliver({ announcement: head('2', other), peers: connected.slice(0, limit) });
    delivery.deliver({ announcement: head('3', other), peers: connected.slice(1) });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await settle();

    const sentBy = (sender: string): string[][] => sends
      .filter(({ author: by, peerId }) => by === sender && peerId !== 'slow-peer')
      .map(({ peerId, version }) => [peerId, version]);
    expect(sentBy(AUTHOR)).toEqual([
      ...first.map((peerId) => [peerId, '2']),
      ...second.map((peerId) => [peerId, '3']),
    ]);
    expect(sentBy(other)).toEqual([
      [connected[0]!, '2'],
      ...connected.slice(1).map((peerId) => [peerId, '3']),
    ]);
  });

  it('keeps members that a newer head\'s peers push past the limit of one fan-out', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour, refused } = harness();
    behaviour.set('slow-peer', 'stall');
    const limit = RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1;
    // A private graph on a busy node: most of the peers a hand-off names are not members.
    const outsiders = peers(limit - 2, 'outsider');
    const members = ['member-y', 'member-z'];
    const newcomers = peers(limit, 'newcomer');
    for (const peerId of [...outsiders, ...newcomers]) refused.add(peerId);

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    // The two members come last in the list handed off with version 2. The list handed off with
    // version 3 names 64 other peers, none of them a member.
    delivery.deliver({ announcement: head('2'), peers: [...outsiders, ...members] });
    delivery.deliver({ announcement: head('3'), peers: newcomers });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await settle();

    // Every named peer is asked about. The limit of 64 never decides who is a member.
    expect(sends.slice(1).map(({ peerId, version }) => [peerId, version])).toEqual([
      ['member-y', '2'],
      ['member-z', '2'],
    ]);
    expect(outcomes.slice(1).map(({ announcement, announcedPeers, refusedPeers }) => [
      announcement.catalogVersion,
      announcedPeers.length,
      refusedPeers.length,
    ])).toEqual([['2', 2, limit - 2], ['3', 0, limit]]);
  });

  it('keeps an older head handed off late for the peers the newest head has no room for', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');
    const own = peers(RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1, 'own');
    const late = peers(3, 'late');

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('5'), peers: own });
    delivery.deliver({ announcement: head('4'), peers: [own[0]!, ...late] });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await settle();

    expect(sends.slice(1).map(({ peerId, version }) => [peerId, version])).toEqual([
      ...late.map((peerId) => [peerId, '4']),
      ...own.map((peerId) => [peerId, '5']),
    ]);
    expect(outcomes.reduce((sum, { supersededHeads }) => sum + supersededHeads, 0)).toBe(0);
  });

  it('reports peers it had to leave out because no place was free to keep their head', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness({ maxWaitingHeadsPerScope: 1 });
    behaviour.set('slow-peer', 'stall');
    const limit = RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1;
    const first = peers(limit, 'first');
    const second = peers(limit, 'second');
    const other = author(1);

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    delivery.deliver({ announcement: head('1', other), peers: ['slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('2'), peers: first });
    delivery.deliver({ announcement: head('3'), peers: second });
    // In the other scope the head that cannot be kept is an older one handed off late.
    delivery.deliver({ announcement: head('3', other), peers: second });
    delivery.deliver({ announcement: head('2', other), peers: first });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await settle();

    // Each scope may hold one waiting head: the newest goes to its own peers and the fan-out
    // says that something was given up.
    for (const sender of [AUTHOR, other]) {
      expect(sends
        .filter(({ author: by, peerId }) => by === sender && peerId !== 'slow-peer')
        .map(({ peerId, version }) => [peerId, version]))
        .toEqual(second.map((peerId) => [peerId, '3']));
    }
    expect(outcomes
      .filter(({ announcement }) => announcement.catalogVersion === '3')
      .map((outcome) => [outcome.supersededHeads, outcome.checkpointCapacityExceeded]))
      .toEqual([[1, true], [1, true]]);
  });

  it('keeps the heads of two policy generations of one catalog scope apart', async () => {
    // A graph authored before its registration has owner-signed heads and, after it, heads of the
    // registered generation. Both carry the same graph, author and era on the wire, and the new
    // generation starts again at version 1.
    vi.useFakeTimers();
    const registered = `0x${'3f'.repeat(32)}`;
    let accepted = POLICY_DIGEST;
    const { delivery, sends, outcomes, behaviour } = harness({
      assertDeliverable: (announcement) => {
        if (announcement.policyDigest !== accepted) {
          throw new Error('announcement is not bound to the accepted policy');
        }
      },
    });
    behaviour.set('slow-peer', 'stall');

    delivery.deliver({ announcement: head('4'), peers: ['slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('5'), peers: ['slow-peer'] });
    // The registration is accepted while version 4 is being sent and version 5 waits.
    accepted = registered;
    expect(delivery.deliver({
      announcement: head('1', AUTHOR, registered),
      peers: ['peer-a'],
    }).status).toBe('queued');
    await settle();

    // The new generation's first head is not compared with the old generation's versions, and it
    // does not wait behind them.
    expect(sends.map(({ peerId, version }) => [peerId, version])).toEqual([
      ['slow-peer', '4'],
      ['peer-a', '1'],
    ]);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await settle();

    // The old generation's waiting head is no longer deliverable, and says so.
    expect(sends).toHaveLength(2);
    expect(outcomes.map(({ announcement, notDeliverable }) => [
      announcement.catalogVersion,
      announcement.policyDigest === registered ? 'registered' : 'owner-signed',
      notDeliverable,
    ])).toEqual([
      ['1', 'registered', null],
      ['4', 'owner-signed', null],
      ['5', 'owner-signed', 'announcement is not bound to the accepted policy'],
    ]);
  });

  it('keeps a checkpoint so that two sent heads are never further apart than a receiver can prove', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');
    const step = RFC64_CATALOG_HEAD_DELIVERY_MAX_VERSION_STEP_V1;
    expect(step * 2).toBe(RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1);
    const last = 6 * step;

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer', 'peer-a'] });
    await settle();
    // Three whole lineage windows of versions commit while version 1 is being sent.
    for (let version = 2; version <= last; version += 1) {
      delivery.deliver({ announcement: head(String(version)), peers: ['slow-peer', 'peer-a'] });
    }
    expect(delivery.pendingScopes).toBe(1);
    await vi.advanceTimersByTimeAsync(7 * BUDGET_MS);
    await settle();

    const sentToPeerA = sends.filter(({ peerId }) => peerId === 'peer-a')
      .map(({ version }) => Number(version));
    expect(sentToPeerA).toEqual([
      1, 1 + step, 1 + 2 * step, 1 + 3 * step, 1 + 4 * step, 1 + 5 * step, last,
    ]);
    for (let index = 1; index < sentToPeerA.length; index += 1) {
      expect(sentToPeerA[index]! - sentToPeerA[index - 1]!).toBeLessThanOrEqual(step);
    }
    expect(outcomes.some(({ checkpointCapacityExceeded }) => checkpointCapacityExceeded)).toBe(false);
    // Every other waiting head was replaced, and each is counted once.
    expect(outcomes.reduce((sum, { supersededHeads }) => sum + supersededHeads, 0))
      .toBe(last - sentToPeerA.length);
  });

  it('keeps a checkpoint for every step of a backlog as deep as one scope may hold', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');
    const step = RFC64_CATALOG_HEAD_DELIVERY_MAX_VERSION_STEP_V1;
    const waitingHeads = RFC64_CATALOG_HEAD_DELIVERY_MAX_WAITING_HEADS_PER_SCOPE_V1;
    // One hand-off per step is all it takes: what counts is how far apart the versions are.
    const versionAt = (steps: number): number => 1 + steps * step;

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    for (let steps = 1; steps <= waitingHeads; steps += 1) {
      delivery.deliver({ announcement: head(String(versionAt(steps))), peers: ['slow-peer'] });
    }
    await vi.advanceTimersByTimeAsync((waitingHeads + 1) * BUDGET_MS);
    await settle();

    // The scope was 65,536 versions ahead of its fan-out, and every step of it was sent.
    expect(versionAt(waitingHeads) - 1).toBe(65_536);
    expect(sends.map(({ version }) => Number(version)))
      .toEqual(Array.from({ length: waitingHeads + 1 }, (_, steps) => versionAt(steps)));
    expect(outcomes.some(({ checkpointCapacityExceeded }) => checkpointCapacityExceeded)).toBe(false);
    expect(outcomes.reduce((sum, { supersededHeads }) => sum + supersededHeads, 0)).toBe(0);
  });

  it('reports a backlog deeper than one scope may hold, and still sends the newest head', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness({ maxWaitingHeadsPerScope: 3 });
    behaviour.set('slow-peer', 'stall');
    const step = RFC64_CATALOG_HEAD_DELIVERY_MAX_VERSION_STEP_V1;
    const last = 5 * step + 7;

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    for (let version = 2; version <= last; version += 1) {
      delivery.deliver({ announcement: head(String(version)), peers: ['slow-peer'] });
    }
    await vi.advanceTimersByTimeAsync(4 * BUDGET_MS);
    await settle();

    // Three heads wait: two checkpoints and the newest. Nothing waits for a place, so the newest
    // head replaces the waiting one although it is further from the last checkpoint than a step.
    expect(sends.map(({ version }) => Number(version))).toEqual([1, 1 + step, 1 + 2 * step, last]);
    // The fan-out that follows says that the scope outran its checkpoints, once.
    expect(outcomes.map(({ announcement, checkpointCapacityExceeded }) => [
      Number(announcement.catalogVersion),
      checkpointCapacityExceeded,
    ])).toEqual([[1, false], [1 + step, true], [1 + 2 * step, false], [last, false]]);
    expect(outcomes.reduce((sum, { supersededHeads }) => sum + supersededHeads, 0)).toBe(last - 4);
  });

  it('bounds the checkpoints of all scopes together, and frees a place when one is sent', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness({ maxCheckpoints: 2 });
    behaviour.set('slow-peer', 'stall');
    const step = RFC64_CATALOG_HEAD_DELIVERY_MAX_VERSION_STEP_V1;
    const versionAt = (steps: number): string => String(1 + steps * step);
    const first = author(0);
    const second = author(1);
    const sentBy = (sender: string): number[] => sends
      .filter(({ author: by }) => by === sender)
      .map(({ version }) => Number(version));

    delivery.deliver({ announcement: head('1', first), peers: ['slow-peer'] });
    delivery.deliver({ announcement: head('1', second), peers: ['slow-peer'] });
    await settle();
    // The first scope takes both places: its waiting heads are two checkpoints and its newest.
    for (let steps = 1; steps <= 3; steps += 1) {
      delivery.deliver({ announcement: head(versionAt(steps), first), peers: ['slow-peer'] });
    }
    // The second scope finds none: its newest head has a place, a checkpoint before it has not.
    delivery.deliver({ announcement: head(versionAt(1), second), peers: ['slow-peer'] });
    delivery.deliver({ announcement: head(versionAt(2), second), peers: ['slow-peer'] });

    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await settle();
    // Both scopes sent their next head; the first scope's was a checkpoint, so one place is free.
    expect(sentBy(first)).toEqual([1, 1 + step]);
    expect(sentBy(second)).toEqual([1, 1 + 2 * step]);
    delivery.deliver({ announcement: head(versionAt(3), second), peers: ['slow-peer'] });
    delivery.deliver({ announcement: head(versionAt(4), second), peers: ['slow-peer'] });

    await vi.advanceTimersByTimeAsync(4 * BUDGET_MS);
    await settle();
    expect(sentBy(first)).toEqual([1, 1 + step, 1 + 2 * step, 1 + 3 * step]);
    // Version 1 + 3 * step was kept as a checkpoint in the place the first scope gave back.
    expect(sentBy(second)).toEqual([1, 1 + 2 * step, 1 + 3 * step, 1 + 4 * step]);
    expect(outcomes.filter(({ checkpointCapacityExceeded }) => checkpointCapacityExceeded)
      .map(({ announcement }) => [announcement.authorAddress, Number(announcement.catalogVersion)]))
      .toEqual([[second, 1 + 2 * step]]);
    // By default one scope alone never runs into the bound for all of them.
    expect(RFC64_CATALOG_HEAD_DELIVERY_MAX_CHECKPOINTS_V1)
      .toBeGreaterThan(RFC64_CATALOG_HEAD_DELIVERY_MAX_WAITING_HEADS_PER_SCOPE_V1);
  });

  it('never runs two fan-outs of one scope at once, and runs different scopes side by side', async () => {
    vi.useFakeTimers();
    const { delivery, sends, behaviour, mostInFlightByAuthor } = harness();
    behaviour.set('slow-peer', 'stall');
    const other = author(1);

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    delivery.deliver({ announcement: head('1', other), peers: ['slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('2'), peers: ['slow-peer'] });
    await settle();

    // Both scopes are sending their first head; the second head of the first scope waits.
    expect(sends.map(({ author: sender, version }) => [sender, version])).toEqual([
      [AUTHOR, '1'],
      [other, '1'],
    ]);
    expect(delivery.pendingScopes).toBe(2);
    await vi.advanceTimersByTimeAsync(2 * BUDGET_MS);

    expect(sends.map(({ author: sender, version }) => [sender, version])).toEqual([
      [AUTHOR, '1'],
      [other, '1'],
      [AUTHOR, '2'],
    ]);
    expect(mostInFlightByAuthor.get(AUTHOR)).toBe(1);
    expect(mostInFlightByAuthor.get(other)).toBe(1);
  });

  it('bounds the fan-outs that select peers at once; a scope waiting for its turn sends its newest head', async () => {
    vi.useFakeTimers();
    const selecting: string[] = [];
    const finishSelection: Array<() => void> = [];
    const { delivery, sends } = harness({
      isPeerAuthorized: (peerId) => new Promise((resolve) => {
        selecting.push(peerId);
        finishSelection.push(() => resolve(true));
      }),
    });
    const scopes = RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 + 2;
    const peerOf = (index: number): string => `peer-of-scope-${index}`;

    for (let index = 0; index < scopes; index += 1) {
      delivery.deliver({ announcement: head('5000', author(index)), peers: [peerOf(index)] });
    }
    await settle();
    expect(selecting).toEqual(
      Array.from({ length: RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 }, (_, index) => peerOf(index)),
    );
    // The last scope has not had its turn: a newer head replaces the one it is waiting with,
    // also when its owner's first head is far from version 1.
    delivery.deliver({ announcement: head('5001', author(scopes - 1)), peers: [peerOf(scopes - 1)] });

    // One fan-out finishes selecting and starts its send: exactly one more scope gets a turn.
    finishSelection[0]!();
    await settle();
    expect(sends.map(({ peerId }) => peerId)).toEqual([peerOf(0)]);
    expect(selecting).toHaveLength(RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 + 1);

    while (delivery.pendingScopes > 0) {
      for (const finish of finishSelection.splice(0)) finish();
      await settle();
    }
    expect(sends).toHaveLength(scopes);
    expect(sends.find(({ author: sender }) => sender === author(scopes - 1))!.version).toBe('5001');
  });

  it('gives its turn back once the sends have started: a peer that never answers holds no other scope', async () => {
    vi.useFakeTimers();
    const { delivery, sends, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');
    const scopes = RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 + 3;

    for (let index = 0; index < scopes; index += 1) {
      delivery.deliver({ announcement: head('1', author(index)), peers: ['slow-peer', `peer-${index}`] });
    }
    await settle();

    // Every scope has started its sends, and every healthy peer has its head, although the
    // stalled peer keeps each of the fan-outs open until its budget ends.
    expect(sends).toHaveLength(2 * scopes);
    expect(delivery.pendingScopes).toBe(scopes);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(delivery.pendingScopes).toBe(0);
  });

  it('bounds the scopes that hold a waiting head', async () => {
    vi.useFakeTimers();
    const { delivery, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');

    for (let index = 0; index < RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1; index += 1) {
      expect(delivery.deliver({ announcement: head('1', author(index)), peers: ['slow-peer'] }).status)
        .toBe('queued');
    }
    expect(delivery.pendingScopes).toBe(RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1);

    const overflow = author(RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1);
    expect(delivery.deliver({ announcement: head('1', overflow), peers: ['slow-peer'] }))
      .toEqual({ status: 'not-queued', reason: 'full' });
    // A scope that already has its slot still takes a newer head.
    expect(delivery.deliver({ announcement: head('2', author(0)), peers: ['slow-peer'] }).status)
      .toBe('queued');
    expect(delivery.pendingScopes).toBe(RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1);
    await delivery.close();
    expect(delivery.pendingScopes).toBe(0);
  });
});

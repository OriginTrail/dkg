// SPDX-License-Identifier: Apache-2.0

/**
 * Shares into a public graph that reached nobody, or not the graph's owner,
 * kept and sent again for a bounded time (`swm/owed-public-shares.ts`). The
 * agent's wiring is in `swm-owed-public-share-wiring.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GOSSIP_ENVELOPE_FRESHNESS_MS,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  encodeGossipEnvelope,
} from '@origintrail-official/dkg-core';
import {
  OWED_PUBLIC_SHARE_OWNER_PEERS_MAX,
  OWED_PUBLIC_SHARE_RESIGN_AFTER_MS,
  OWED_PUBLIC_SHARE_RESIGN_FAILURES_MAX,
  OWED_PUBLIC_SHARE_RETRY_MS,
  OWED_PUBLIC_SHARE_TTL_MS,
  OWED_PUBLIC_SHARES_MAX,
  OWED_PUBLIC_SHARES_MAX_BYTES,
  OWED_PUBLIC_SHARES_PER_PASS,
  OwedPublicShares,
  envelopeSignedAtMs,
  owedPublicSharesOf,
  owedShareOutcomeOf,
  peekOwedPublicShares,
  type OwedPublicShare,
  type OwedPublicShareInput,
  type OwedPublicSharePorts,
  type OwedShareSendOutcome,
} from '../src/swm/owed-public-shares.js';

const GRAPH = '0x1111111111111111111111111111111111111111/owed-shares';
const OTHER_GRAPH = '0x2222222222222222222222222222222222222222/owed-shares';
const OWNER = '12D3KooWOwnerOfTheGraph';
const OWNER_2 = '12D3KooWSecondOwnerPeer';
const OWNER_3 = '12D3KooWThirdOwnerPeer';
const CORE_1 = '12D3KooWCoreOne';
const CORE_2 = '12D3KooWCoreTwo';
const CORE_3 = '12D3KooWCoreThree';

interface Sent {
  readonly peerId: string;
  readonly shareOperationId: string;
  readonly wire: string;
  readonly attempt: number;
}

/** A store with fake ports, a clock the test moves, and a timer the test fires. */
function harness(options: {
  owners?: () => readonly string[] | Promise<readonly string[]>;
  /** The connected Cores; the store's own exclusions are applied to them, as the agent applies them. */
  holders?: () => readonly string[];
  answer?: (peerId: string, share: OwedPublicShare<string>) => OwedShareSendOutcome | Promise<OwedShareSendOutcome>;
  resign?: (share: OwedPublicShare<string>) => Promise<Uint8Array>;
  isPublic?: (contextGraphId: string) => Promise<boolean>;
  open?: () => boolean;
  maxBytes?: number;
} = {}) {
  const clock = { now: 1_000_000 };
  const sent: Sent[] = [];
  const ownerLookups: string[] = [];
  const holderLookups: string[] = [];
  const publicLookups: string[] = [];
  const resigned: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  let timers = 0;
  let pending: (() => void) | null = null;
  const ports: OwedPublicSharePorts<string> = {
    isPublic: async (contextGraphId) => {
      publicLookups.push(contextGraphId);
      return options.isPublic === undefined ? true : options.isPublic(contextGraphId);
    },
    holderPeers: async (contextGraphId, _subGraphName, exclude) => {
      holderLookups.push(contextGraphId);
      return (options.holders?.() ?? []).filter((peerId) => !exclude.has(peerId));
    },
    ownerPeers: async (contextGraphId) => {
      ownerLookups.push(contextGraphId);
      return options.owners?.() ?? [];
    },
    resign: async (share) => {
      resigned.push(share.shareOperationId);
      return (options.resign ?? (async () => new TextEncoder().encode(`${share.signer}@${clock.now}`)))(share);
    },
    send: async (peerId, share) => {
      sent.push({
        peerId,
        shareOperationId: share.shareOperationId,
        wire: new TextDecoder().decode(share.wire),
        attempt: share.attempts,
      });
      return (options.answer ?? (() => 'delivered'))(peerId, share);
    },
    isOpen: options.open ?? (() => true),
    logInfo: (message) => infos.push(message),
    logWarn: (message) => warnings.push(message),
  };
  const store = new OwedPublicShares(ports, {
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    now: () => clock.now,
    schedule: (run, ms) => {
      expect(ms).toBe(OWED_PUBLIC_SHARE_RETRY_MS);
      timers += 1;
      pending = run;
      return { cancel: () => { pending = null; } };
    },
  });
  const owe = (shareOperationId: string, flags: Partial<OwedPublicShareInput<string>> = {}): void => {
    store.owe({
      shareOperationId,
      contextGraphId: GRAPH,
      subGraphName: 'reports',
      message: new TextEncoder().encode(`message-${shareOperationId}`),
      wire: new TextEncoder().encode(`wire-${shareOperationId}`),
      signedAt: clock.now,
      signer: 'signer',
      holder: false,
      owner: false,
      ...flags,
    });
  };
  return {
    store,
    clock,
    sent,
    ownerLookups,
    holderLookups,
    publicLookups,
    resigned,
    warnings,
    infos,
    owe,
    timersArmed: () => timers,
    /** Run the pass the timer would run, as the timer would. */
    fire: async () => {
      const run = pending;
      expect(run, 'a pass is scheduled').not.toBeNull();
      pending = null;
      run!();
      await store.whenIdle();
    },
    isScheduled: () => pending !== null,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a share owed to the graph\'s owner', () => {
  it('goes to the owner once the owner can be found, and is then forgotten', async () => {
    let known = false;
    const h = harness({ owners: () => (known ? [OWNER] : []) });
    h.owe('op-1', { owner: true });
    for (let pass = 0; pass < 3; pass += 1) {
      h.clock.now += OWED_PUBLIC_SHARE_RETRY_MS;
      await h.fire();
    }
    expect(h.sent).toEqual([]);
    expect(h.store.size).toBe(1);
    known = true;
    h.clock.now += OWED_PUBLIC_SHARE_RETRY_MS;
    await h.fire();
    expect(h.sent.map((sent) => sent.peerId)).toEqual([OWNER]);
    expect(h.store.size).toBe(0);
    expect(h.isScheduled(), 'nothing is scheduled while nothing is owed').toBe(false);
    expect(h.infos.some((line) => line.includes('op-1') && line.includes('owner'))).toBe(true);
  });

  it('stays owed while the owner answers "not now" or the send fails, and tries at most two owner peers a pass', async () => {
    const answers: OwedShareSendOutcome[] = ['retryable', 'failed'];
    const h = harness({
      owners: () => [OWNER, OWNER_2, OWNER_3],
      answer: () => answers.shift() ?? 'delivered',
    });
    h.owe('op-1', { owner: true });
    await h.store.tick();
    expect(h.sent.map((sent) => sent.peerId)).toEqual([OWNER, OWNER_2]);
    expect(h.store.size).toBe(1);
    await h.store.tick();
    expect(h.sent.map((sent) => sent.peerId)).toEqual([OWNER, OWNER_2, OWNER]);
    expect(h.store.size).toBe(0);
    expect(OWED_PUBLIC_SHARE_OWNER_PEERS_MAX).toBe(2);
  });

  it('is dropped with a warning when the owner refuses it', async () => {
    const h = harness({ owners: () => [OWNER, OWNER_2], answer: () => 'rejected' });
    h.owe('op-1', { owner: true });
    await h.store.tick();
    expect(h.sent.map((sent) => sent.peerId)).toEqual([OWNER]);
    expect(h.store.size).toBe(0);
    expect(h.warnings.some((line) => line.includes('op-1') && line.includes('refused'))).toBe(true);
  });

  it('looks the owner of a graph up once a pass, whatever number of its shares are owed', async () => {
    const h = harness({ owners: () => [] });
    h.owe('op-1', { owner: true });
    h.owe('op-2', { owner: true });
    h.owe('op-3', { owner: true, contextGraphId: OTHER_GRAPH });
    await h.store.tick();
    expect(h.ownerLookups.sort()).toEqual([GRAPH, OTHER_GRAPH].sort());
    await h.store.tick();
    expect(h.ownerLookups).toHaveLength(4);
  });

  it('survives an owner lookup or a send that throws', async () => {
    let lookups = 0;
    const h = harness({
      owners: () => {
        lookups += 1;
        if (lookups === 1) throw new Error('route failed');
        return [OWNER];
      },
      answer: () => { throw new Error('stream reset'); },
    });
    h.owe('op-1', { owner: true });
    await h.store.tick();
    expect(h.sent).toEqual([]);
    await h.store.tick();
    expect(h.sent.map((sent) => sent.peerId)).toEqual([OWNER]);
    expect(h.store.size, 'a send that threw counts as failed').toBe(1);
  });
});

describe('a share that reached nobody', () => {
  it('waits for a connected Core, then goes to every one and is settled by a delivery', async () => {
    let cores: string[] = [];
    const h = harness({
      holders: () => cores,
      answer: (peerId) => (peerId === CORE_1 ? 'retryable' : 'delivered'),
    });
    h.owe('op-1', { holder: true });
    await h.store.tick();
    expect(h.sent).toEqual([]);
    expect(h.holderLookups).toEqual([GRAPH]);
    cores = [CORE_1, CORE_2];
    await h.store.tick();
    expect(h.sent.map((sent) => sent.peerId).sort()).toEqual([CORE_1, CORE_2]);
    expect(h.store.size).toBe(0);
  });

  it('is not sent again to a Core that refused it, and the other Cores, and Cores that connect later, keep being tried', async () => {
    let cores = [CORE_1, CORE_2];
    const h = harness({
      holders: () => cores,
      answer: (peerId) => (peerId === CORE_1 ? 'rejected' : 'retryable'),
    });
    h.owe('op-1', { holder: true, subGraphName: null });
    await h.store.tick();
    expect(h.sent.map((sent) => sent.peerId).sort()).toEqual([CORE_1, CORE_2]);
    expect(h.store.size).toBe(1);
    cores = [CORE_1, CORE_2, CORE_3];
    await h.store.tick();
    expect(h.sent.slice(2).map((sent) => sent.peerId).sort()).toEqual([CORE_3, CORE_2].sort());
    expect(h.store.size).toBe(1);
  });

  // Receivers answer an outdated version of an asset as they answer a graph
  // they do not host. Cores that refuse a kept share as outdated are asked
  // once; they are not asked again, and the record no longer waits for them.
  it('owes the Cores nothing more once every Core it went to refuses it, and still owes the owner', async () => {
    const h = harness({ holders: () => [CORE_1, CORE_2], answer: () => 'rejected' });
    h.owe('op-1', { holder: true });
    h.owe('op-2', { holder: true, owner: true });
    await h.store.tick();
    expect(h.sent.map((sent) => `${sent.shareOperationId}:${sent.peerId}`).sort())
      .toEqual([`op-1:${CORE_1}`, `op-1:${CORE_2}`, `op-2:${CORE_1}`, `op-2:${CORE_2}`]);
    expect(h.store.snapshot()).toMatchObject([{ shareOperationId: 'op-2', holder: false, owner: true }]);
    expect(h.infos.filter((line) => line.includes('refused by every Core'))).toHaveLength(2);
    await h.store.tick();
    expect(h.sent, 'no Core is sent a refused share again').toHaveLength(4);
  });

  it('survives a lookup of the connected Cores that throws', async () => {
    const h = harness({ holders: () => { throw new Error('no peers'); } });
    h.owe('op-1', { holder: true });
    await h.store.tick();
    expect(h.store.size).toBe(1);
  });

  it('is forgotten only once both what it owed the owner and what it owed a holder are settled', async () => {
    let owners: string[] = [];
    const h = harness({ holders: () => [CORE_1], owners: () => owners });
    h.owe('op-1', { holder: true, owner: true });
    await h.store.tick();
    expect(h.store.size).toBe(1);
    expect(h.store.snapshot()).toMatchObject([{ shareOperationId: 'op-1', holder: false, owner: true }]);
    owners = [OWNER];
    await h.store.tick();
    expect(h.store.size).toBe(0);
  });
});

describe('a share into a graph that is no longer public', () => {
  // A graph without an explicit access policy turns private once an
  // allowlist lands; a share kept from before must not go to Cores then.
  it('is dropped unsent, the graph asked once a pass whatever number of its shares are kept', async () => {
    let isPublic = true;
    const h = harness({ holders: () => [CORE_1], owners: () => [OWNER], answer: () => 'retryable', isPublic: async () => isPublic });
    h.owe('op-1', { holder: true });
    h.owe('op-2', { owner: true });
    h.owe('op-3', { owner: true, contextGraphId: OTHER_GRAPH });
    await h.store.tick();
    expect(h.sent).toHaveLength(3);
    expect(h.publicLookups.sort()).toEqual([GRAPH, OTHER_GRAPH].sort());
    isPublic = false;
    await h.store.tick();
    expect(h.sent).toHaveLength(3);
    expect(h.store.size).toBe(0);
    expect(h.infos.filter((line) => line.includes('not public now'))).toHaveLength(3);
  });

  it('is dropped unsent when the graph\'s access policy cannot be read', async () => {
    const h = harness({ holders: () => [CORE_1], isPublic: async () => { throw new Error('store unavailable'); } });
    h.owe('op-1', { holder: true });
    await h.store.tick();
    expect(h.sent).toEqual([]);
    expect(h.holderLookups).toEqual([]);
    expect(h.store.size).toBe(0);
  });
});

describe('a share that is sent again later', () => {
  it('is signed again once its envelope is about to be too old for its receivers, and is sent under a new message id', async () => {
    const h = harness({ owners: () => [OWNER], answer: () => 'retryable' });
    h.owe('op-1', { owner: true });
    await h.store.tick();
    expect(h.sent[0]).toMatchObject({ wire: 'wire-op-1', attempt: 1 });
    h.clock.now += OWED_PUBLIC_SHARE_RESIGN_AFTER_MS;
    await h.store.tick();
    expect(h.sent[1]).toMatchObject({ wire: `signer@${h.clock.now}`, attempt: 2 });
    expect(h.store.snapshot()[0]?.signedAt).toBe(h.clock.now);
    expect(OWED_PUBLIC_SHARE_RESIGN_AFTER_MS).toBeLessThan(GOSSIP_ENVELOPE_FRESHNESS_MS);
  });

  it('is kept, and not sent, when signing it again fails; the next pass signs it', async () => {
    let failures = 1;
    const h = harness({
      owners: () => [OWNER],
      resign: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('signer unavailable');
        }
        return new TextEncoder().encode('fresh');
      },
    });
    h.owe('op-1', { owner: true, signedAt: h.clock.now - OWED_PUBLIC_SHARE_RESIGN_AFTER_MS });
    await h.store.tick();
    expect(h.sent).toEqual([]);
    expect(h.store.size).toBe(1);
    expect(h.infos.some((line) => line.includes('signer unavailable'))).toBe(true);
    await h.store.tick();
    expect(h.sent.map((sent) => sent.wire)).toEqual(['fresh']);
    expect(h.store.size).toBe(0);
  });

  it('is given up with a warning after three failed signings', async () => {
    const h = harness({ owners: () => [OWNER], resign: async () => { throw new Error('external signer timed out'); } });
    h.owe('op-1', { owner: true, signedAt: h.clock.now - OWED_PUBLIC_SHARE_RESIGN_AFTER_MS });
    for (let pass = 1; pass < OWED_PUBLIC_SHARE_RESIGN_FAILURES_MAX; pass += 1) {
      await h.store.tick();
      expect(h.store.size).toBe(1);
    }
    expect(h.warnings).toEqual([]);
    await h.store.tick();
    expect(h.store.size).toBe(0);
    expect(h.sent).toEqual([]);
    expect(h.resigned).toHaveLength(OWED_PUBLIC_SHARE_RESIGN_FAILURES_MAX);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('op=op-1');
    expect(h.warnings[0]).toContain('not signed again after 3 tries: external signer timed out');
  });

  it('expires with a warning naming what it never reached', async () => {
    const h = harness();
    h.owe('op-1', { holder: true, owner: true });
    h.clock.now += OWED_PUBLIC_SHARE_TTL_MS;
    await h.store.tick();
    expect(h.store.size).toBe(0);
    const warning = h.warnings.find((line) => line.includes('op-1'));
    expect(warning).toContain('any peer');
    expect(warning).toContain('owner');
    expect(h.ownerLookups).toEqual([]);
  });
});

describe('the store of owed shares', () => {
  it('keeps one record per share, merging what each owed', () => {
    const h = harness();
    h.owe('op-1', { holder: true });
    h.owe('op-1', { owner: true });
    h.owe('op-1', {});
    expect(h.store.size).toBe(1);
    expect(h.store.snapshot()).toMatchObject([{ shareOperationId: 'op-1', holder: true, owner: true, attempts: 0 }]);
  });

  it('ignores a share that owes nothing', () => {
    const h = harness();
    h.owe('op-1');
    expect(h.store.size).toBe(0);
    expect(h.timersArmed()).toBe(0);
  });

  it('keeps at most 64 shares, the oldest making room, with one warning at the next pass', async () => {
    const h = harness();
    for (let index = 0; index <= OWED_PUBLIC_SHARES_MAX; index += 1) h.owe(`op-${index}`, { owner: true });
    expect(h.store.size).toBe(OWED_PUBLIC_SHARES_MAX);
    expect(h.store.snapshot()[0]?.shareOperationId).toBe('op-1');
    expect(h.warnings).toEqual([]);
    await h.store.tick();
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/^1 SWM share dropped to make room/);
    expect(h.warnings[0]).toContain('op=op-0 (owed the graph\'s owner)');
  });

  // A busy writer whose graph's owner is offline keeps a share owed to the
  // owner for each of its shares: one warning a pass, not one a share.
  it('warns of shares dropped for room, and of shares given up, once a pass each, naming three and counting the rest', async () => {
    const h = harness();
    for (let index = 0; index < OWED_PUBLIC_SHARES_MAX + 5; index += 1) h.owe(`op-${index}`, { owner: true });
    await h.store.tick();
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/^5 SWM shares dropped to make room/);
    expect(h.warnings[0]).toContain('op=op-0 ');
    expect(h.warnings[0]).toContain('op=op-2 ');
    expect(h.warnings[0]).not.toContain('op=op-3 ');
    expect(h.warnings[0]).toMatch(/; and 2 more$/);
    h.clock.now += OWED_PUBLIC_SHARE_TTL_MS;
    await h.store.tick();
    expect(h.warnings).toHaveLength(2);
    expect(h.warnings[1]).toMatch(new RegExp(`^${OWED_PUBLIC_SHARES_MAX} SWM shares given up after 30 min`));
    expect(h.store.size).toBe(0);
  });

  it('keeps at most its byte budget of shares, the oldest making room, and never one larger than the budget', async () => {
    // Each share below is 16 bytes: its message and its envelope, 8 bytes each.
    const h = harness({ maxBytes: 40 });
    const bytes = (text: string) => new TextEncoder().encode(text);
    h.owe('op-a', { owner: true, message: bytes('messageA'), wire: bytes('wire-opA') });
    h.owe('op-b', { owner: true, message: bytes('messageB'), wire: bytes('wire-opB') });
    expect(h.store.size).toBe(2);
    h.owe('op-c', { owner: true, message: bytes('messageC'), wire: bytes('wire-opC') });
    expect(h.store.snapshot().map((share) => share.shareOperationId)).toEqual(['op-b', 'op-c']);
    h.owe('op-big', { owner: true, message: new Uint8Array(30), wire: new Uint8Array(11) });
    expect(h.store.snapshot().map((share) => share.shareOperationId)).toEqual(['op-b', 'op-c']);
    expect(h.warnings.some((line) => line.includes('op-big') && line.includes('not kept'))).toBe(true);
    await h.store.tick();
    expect(h.warnings.some((line) => line.includes('op-a') && line.includes('dropped'))).toBe(true);
    expect(OWED_PUBLIC_SHARES_MAX_BYTES).toBe(32 * 1024 * 1024);
  });

  it('works through at most eight shares a pass, oldest first', async () => {
    const h = harness({ owners: () => [OWNER], answer: () => 'retryable' });
    for (let index = 0; index < 10; index += 1) h.owe(`op-${index}`, { owner: true });
    await h.store.tick();
    expect(h.sent.map((sent) => sent.shareOperationId)).toEqual(
      Array.from({ length: OWED_PUBLIC_SHARES_PER_PASS }, (_unused, index) => `op-${index}`),
    );
  });

  // Eight shares whose owners keep answering "not now" held every place of
  // every pass: a ninth, whose owner would take it at once, expired unsent.
  it('gives every share its turn: shares that keep failing do not keep a newer one from being sent', async () => {
    const h = harness({
      owners: () => [OWNER],
      answer: (_peerId, share) => (share.shareOperationId === 'op-8' ? 'delivered' : 'retryable'),
    });
    for (let index = 0; index < 9; index += 1) h.owe(`op-${index}`, { owner: true });
    const sentInPass = async (): Promise<string[]> => {
      const before = h.sent.length;
      h.clock.now += OWED_PUBLIC_SHARE_RETRY_MS;
      await h.fire();
      return h.sent.slice(before).map((sent) => sent.shareOperationId);
    };
    const ids = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_unused, index) => `op-${from + index}`);
    expect(await sentInPass()).toEqual(ids(0, 7));
    expect(await sentInPass(), 'the share not tried yet goes first').toEqual(['op-8', ...ids(0, 6)]);
    expect(h.store.snapshot().map((share) => share.shareOperationId)).toEqual(ids(0, 7));
    expect(await sentInPass(), 'the share left out of the last pass goes first').toEqual(['op-7', ...ids(0, 6)]);
    expect((await sentInPass()).sort(), 'with no more shares than a pass sends, each is sent every pass').toEqual(ids(0, 7));
    expect(h.store.snapshot().every((share) => share.attempts >= 3)).toBe(true);
  });

  it('takes turns within each kind, those that reached nobody still before those owed only to the owner', async () => {
    const h = harness({ owners: () => [OWNER], holders: () => [CORE_1], answer: () => 'retryable' });
    for (let index = 0; index < 10; index += 1) h.owe(`op-owner-${index}`, { owner: true });
    for (let index = 0; index < 3; index += 1) h.owe(`op-nobody-${index}`, { holder: true });
    const nobody = ['op-nobody-0', 'op-nobody-1', 'op-nobody-2'];
    const owner = (indexes: number[]): string[] => indexes.map((index) => `op-owner-${index}`);
    await h.store.tick();
    expect(h.sent.map((sent) => sent.shareOperationId)).toEqual([...nobody, ...owner([0, 1, 2, 3, 4])]);
    await h.store.tick();
    expect(h.sent.slice(8).map((sent) => sent.shareOperationId)).toEqual([...nobody, ...owner([5, 6, 7, 8, 9])]);
    await h.store.tick();
    expect(h.sent.slice(16).map((sent) => sent.shareOperationId)).toEqual([...nobody, ...owner([0, 1, 2, 3, 4])]);
  });

  it('sends a share that reached nobody before older shares owed only to the owner', async () => {
    const h = harness({ owners: () => [OWNER], holders: () => [CORE_1], answer: () => 'retryable' });
    for (let index = 0; index < 10; index += 1) h.owe(`op-${index}`, { owner: true });
    h.owe('op-nobody', { holder: true });
    await h.store.tick();
    expect(h.sent.map((sent) => sent.shareOperationId)).toEqual([
      'op-nobody',
      ...Array.from({ length: OWED_PUBLIC_SHARES_PER_PASS - 1 }, (_unused, index) => `op-${index}`),
    ]);
  });

  it('does not count, nor sign again, a share with nobody to go to', async () => {
    const h = harness({ owners: () => [OWNER], holders: () => [], answer: () => 'retryable' });
    const old = h.clock.now - OWED_PUBLIC_SHARE_RESIGN_AFTER_MS;
    for (let index = 0; index < 9; index += 1) h.owe(`op-nobody-${index}`, { holder: true, signedAt: old });
    for (let index = 0; index < 10; index += 1) h.owe(`op-owner-${index}`, { owner: true });
    await h.store.tick();
    // No Core is connected: the shares that reached nobody wait without using up the pass.
    expect(h.sent.map((sent) => sent.shareOperationId)).toEqual(
      Array.from({ length: OWED_PUBLIC_SHARES_PER_PASS }, (_unused, index) => `op-owner-${index}`),
    );
    expect(h.holderLookups).toHaveLength(9);
    expect(h.resigned).toEqual([]);
    expect(h.store.snapshot().filter((share) => share.holder).every((share) => share.attempts === 0)).toBe(true);
  });

  it('runs one pass at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({
      owners: () => [OWNER],
      answer: async () => {
        await gate;
        return 'retryable';
      },
    });
    h.owe('op-1', { owner: true });
    const first = h.store.tick();
    const second = h.store.tick();
    release();
    await Promise.all([first, second]);
    expect(h.sent).toHaveLength(1);
  });

  it('is scheduled only while it holds a share', async () => {
    const h = harness({ owners: () => [OWNER] });
    expect(h.isScheduled()).toBe(false);
    h.owe('op-1', { owner: true });
    h.owe('op-2', { owner: true });
    expect(h.timersArmed(), 'one timer for any number of shares').toBe(1);
    await h.fire();
    expect(h.store.size).toBe(0);
    expect(h.isScheduled()).toBe(false);
    h.owe('op-3', { holder: true });
    expect(h.isScheduled()).toBe(true);
    await h.fire();
    expect(h.isScheduled(), 'still owed: the next pass is scheduled').toBe(true);
  });

  it('sends nothing once closed, not even from a pass that was running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({
      owners: async () => {
        await gate;
        return [OWNER];
      },
    } as never);
    h.owe('op-1', { owner: true });
    const running = h.store.tick();
    h.store.close();
    release();
    await running;
    expect(h.sent).toEqual([]);
    expect(h.store.size).toBe(0);
    expect(h.isScheduled()).toBe(false);
    expect(h.store.closed).toBe(true);
    h.owe('op-2', { owner: true });
    expect(h.store.size, 'a closed store records nothing').toBe(0);
    await h.store.tick();
    expect(h.sent).toEqual([]);
  });

  it('sends and logs nothing from a pass that was running across a stop and a restart, and a new pass works', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({
      owners: () => [OWNER],
      resign: async () => {
        await gate;
        throw new Error('signer went away');
      },
    });
    h.owe('op-1', { owner: true, signedAt: h.clock.now - OWED_PUBLIC_SHARE_RESIGN_AFTER_MS });
    const stale = h.store.tick();
    await vi.waitFor(() => expect(h.resigned).toEqual(['op-1']));
    h.store.close();
    h.store.reopen();
    h.owe('op-2', { owner: true });
    const fresh = h.store.tick();
    expect(fresh, 'a pass from before the stop is not joined').not.toBe(stale);
    await fresh;
    expect(h.sent.map((sent) => sent.shareOperationId)).toEqual(['op-2']);
    release();
    await stale;
    expect(h.sent).toHaveLength(1);
    expect(h.infos.some((line) => line.includes('signer went away')), 'a stopped pass logs nothing').toBe(false);
    expect(h.store.size).toBe(0);
  });

  it('sends nothing while its agent is not running', async () => {
    const h = harness({ owners: () => [OWNER], open: () => false });
    h.owe('op-1', { owner: true });
    await h.store.tick();
    expect(h.sent).toEqual([]);
    expect(h.store.size).toBe(1);
  });

  it('runs its passes on a real timer by default, which does not keep the process alive', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const store = new OwedPublicShares<null>({
      isPublic: async () => true,
      holderPeers: async () => [],
      ownerPeers: async () => [OWNER],
      resign: async (share) => share.wire,
      send: async (peerId) => {
        sent.push(peerId);
        return 'delivered';
      },
      isOpen: () => true,
      logInfo: () => undefined,
      logWarn: () => undefined,
    });
    store.owe({
      shareOperationId: 'op-1',
      contextGraphId: GRAPH,
      subGraphName: 'reports',
      message: new Uint8Array([1]),
      wire: new Uint8Array([2]),
      signedAt: Date.now(),
      signer: null,
      holder: false,
      owner: true,
    });
    await vi.advanceTimersByTimeAsync(OWED_PUBLIC_SHARE_RETRY_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await store.whenIdle();
    expect(sent).toEqual([OWNER]);
    store.close();
  });
});

describe('the outcome of one send', () => {
  it('is delivered, refused or failed as classified, and "not now" for anything still under way', () => {
    expect(owedShareOutcomeOf('delivered')).toBe('delivered');
    expect(owedShareOutcomeOf('rejected')).toBe('rejected');
    expect(owedShareOutcomeOf('failed')).toBe('failed');
    expect(owedShareOutcomeOf('retryable')).toBe('retryable');
    expect(owedShareOutcomeOf('queued')).toBe('retryable');
    expect(owedShareOutcomeOf('inFlight')).toBe('retryable');
  });
});

describe('the time an envelope was signed', () => {
  it('is the timestamp the envelope carries', () => {
    const signedAt = Date.parse('2026-10-18T17:07:22.000Z');
    const wire = encodeGossipEnvelope({
      version: GOSSIP_ENVELOPE_VERSION,
      type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
      contextGraphId: GRAPH,
      agentAddress: '0x1111111111111111111111111111111111111111',
      timestamp: new Date(signedAt).toISOString(),
      signature: new Uint8Array([1]),
      payload: new Uint8Array([2]),
    });
    expect(envelopeSignedAtMs(wire, 5)).toBe(signedAt);
  });

  it('is the fallback for bytes that carry no timestamp', () => {
    expect(envelopeSignedAtMs(new Uint8Array([0xff, 0xff, 0xff]), 5)).toBe(5);
    expect(envelopeSignedAtMs(new Uint8Array(), 7)).toBe(7);
  });
});

describe('the owed shares of an agent', () => {
  function ports(): OwedPublicSharePorts<null> {
    return {
      isPublic: async () => true,
      holderPeers: async () => [],
      ownerPeers: async () => [],
      resign: async (share) => share.wire,
      send: async () => 'retryable',
      isOpen: () => true,
      logInfo: () => undefined,
      logWarn: () => undefined,
    };
  }

  it('are created on first use and kept; once closed they keep nothing until reopened', () => {
    const agent = {};
    const owe = (shares: OwedPublicShares<null>, shareOperationId: string): void => shares.owe({
      shareOperationId,
      contextGraphId: GRAPH,
      subGraphName: null,
      message: new Uint8Array([1]),
      wire: new Uint8Array([2]),
      signedAt: 0,
      signer: null,
      holder: true,
      owner: false,
    });
    expect(peekOwedPublicShares(agent)).toBeUndefined();
    const shares = owedPublicSharesOf(agent, ports);
    expect(owedPublicSharesOf(agent, ports)).toBe(shares);
    expect(peekOwedPublicShares(agent)).toBe(shares);
    shares.close();
    expect(owedPublicSharesOf(agent, ports), 'a stopping agent finds them closed').toBe(shares);
    owe(shares, 'op-while-stopping');
    expect(shares.size).toBe(0);
    shares.reopen();
    expect(shares.closed).toBe(false);
    owe(shares, 'op-after-restart');
    expect(shares.size).toBe(1);
    shares.close();
  });
});

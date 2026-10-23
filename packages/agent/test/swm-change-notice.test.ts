/**
 * The shared-memory change notice of a public graph's owner (#1611): its wire
 * form, the owner's coalesced fan-out, and the follower's gated, coalesced,
 * rate-limited pull. The agent's wiring is in `swm-change-notice-wiring.test.ts`,
 * and the whole path, over the production sync, in `e2e-swm-relay-only.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SWM_CHANGE_NOTICE_KIND_V1,
  SWM_CHANGE_NOTICE_MAX_BYTES,
  SwmChangeNoticeReceiver,
  SwmChangeNotifier,
  decodeSwmChangeNoticeV1,
  encodeSwmChangeNoticeV1,
  sendSwmChangeNotice,
  swmChangeNoticeFailure,
  swmChangeNoticeHint,
  swmChangeRecipients,
  type SwmChangeNoticeDelivery,
  type SwmChangeNoticeOutcome,
  type SwmChangeNoticeReceiverPorts,
  type SwmChangeNoticeV1,
  type SwmChangeNotifierPorts,
  type SwmRemoteChange,
} from '../src/swm/shared-memory-change-notice.js';

const CG = '0x1111111111111111111111111111111111111111/change-notice';
const OWNER = '12D3KooWOwner';
const MEMBER_1 = '12D3KooWMemberOne';
const MEMBER_2 = '12D3KooWMemberTwo';
const MEMBER_3 = '12D3KooWMemberThree';
const UTF8 = new TextEncoder();

const notice = (subGraphName: string | null = 'notes', hint = 'op-1'): SwmChangeNoticeV1 => (
  { contextGraphId: CG, subGraphName, hint }
);

const reachedAll = (recipients: readonly string[]): SwmChangeNoticeDelivery[] => (
  recipients.map((peerId) => ({ peerId, outcome: 'reached' }))
);

describe('change notice wire form', () => {
  it('encodes one canonical JSON object and decodes it back', () => {
    const bytes = encodeSwmChangeNoticeV1(notice());

    expect(new TextDecoder().decode(bytes)).toBe(
      `{"contextGraphId":"${CG}","hint":"op-1","kind":"${SWM_CHANGE_NOTICE_KIND_V1}","subGraphName":"notes"}`,
    );
    expect(decodeSwmChangeNoticeV1(bytes)).toEqual(notice());
    expect(decodeSwmChangeNoticeV1(encodeSwmChangeNoticeV1(notice(null)))).toEqual(notice(null));
  });

  it.each([
    ['another kind', `{"contextGraphId":"${CG}","hint":"op-1","kind":"other","subGraphName":null}`],
    ['keys out of order', `{"kind":"${SWM_CHANGE_NOTICE_KIND_V1}","contextGraphId":"${CG}","hint":"op-1","subGraphName":null}`],
    ['an extra field', `{"contextGraphId":"${CG}","data":"x","hint":"op-1","kind":"${SWM_CHANGE_NOTICE_KIND_V1}","subGraphName":null}`],
    ['a missing hint', `{"contextGraphId":"${CG}","kind":"${SWM_CHANGE_NOTICE_KIND_V1}","subGraphName":null}`],
    ['a numeric sub-graph name', `{"contextGraphId":"${CG}","hint":"op-1","kind":"${SWM_CHANGE_NOTICE_KIND_V1}","subGraphName":7}`],
    ['a reserved sub-graph name', `{"contextGraphId":"${CG}","hint":"op-1","kind":"${SWM_CHANGE_NOTICE_KIND_V1}","subGraphName":"_meta"}`],
    ['an unsafe graph id', `{"contextGraphId":"a b","hint":"op-1","kind":"${SWM_CHANGE_NOTICE_KIND_V1}","subGraphName":null}`],
    ['a hint with a space', `{"contextGraphId":"${CG}","hint":"op 1","kind":"${SWM_CHANGE_NOTICE_KIND_V1}","subGraphName":null}`],
    ['an array', '[]'],
    ['not JSON', 'not json'],
  ])('refuses %s', (_label, text) => {
    expect(() => decodeSwmChangeNoticeV1(UTF8.encode(text))).toThrow(/Invalid shared-memory change notice/);
  });

  it('refuses empty, oversized and non-UTF-8 bytes, and does not encode an invalid notice', () => {
    expect(() => decodeSwmChangeNoticeV1(new Uint8Array())).toThrow(/empty or too large/);
    expect(() => decodeSwmChangeNoticeV1(new Uint8Array(SWM_CHANGE_NOTICE_MAX_BYTES + 1))).toThrow(/empty or too large/);
    expect(() => decodeSwmChangeNoticeV1(new Uint8Array([0xff, 0xfe]))).toThrow(/not JSON/);
    expect(() => encodeSwmChangeNoticeV1(notice('a/b'))).toThrow(/Invalid shared-memory change notice/);
    expect(() => encodeSwmChangeNoticeV1(notice('notes', 'x'.repeat(257)))).toThrow(/hint/);
  });

  it('keeps a hint that fits and replaces one that does not', () => {
    expect(swmChangeNoticeHint('mv8j7ujt-p9ypy5')).toBe('mv8j7ujt-p9ypy5');
    expect(swmChangeNoticeHint(undefined)).toBe('share');
    expect(swmChangeNoticeHint('with space')).toBe('share');
  });

  it('reports how the send to each recipient ended', async () => {
    const send = vi.fn(async (peerId: string) => {
      if (peerId === MEMBER_2) throw new Error('protocol selection failed');
      if (peerId === MEMBER_3) throw new Error('The operation was aborted due to timeout');
    });

    expect(await sendSwmChangeNotice(notice(), [MEMBER_1, MEMBER_2, MEMBER_3], send)).toEqual([
      { peerId: MEMBER_1, outcome: 'reached' },
      { peerId: MEMBER_2, outcome: 'unsupported' },
      { peerId: MEMBER_3, outcome: 'timeout' },
    ]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(decodeSwmChangeNoticeV1(send.mock.calls[0]![1] as unknown as Uint8Array)).toEqual(notice());
  });

  it.each([
    ['protocol selection failed', 'unsupported'],
    ['Protocol selection failed - could not negotiate /dkg/10.0.1/swm-change-notice', 'unsupported'],
    [Object.assign(new Error('nope'), { name: 'UnsupportedProtocolError' }), 'unsupported'],
    ['The operation was aborted due to timeout', 'timeout'],
    [Object.assign(new Error('signal'), { name: 'TimeoutError' }), 'timeout'],
    ['All multiaddr dials failed', 'unreachable'],
    ['failed to connect via relay with status NO_RESERVATION', 'unreachable'],
    ['The stream has been reset', 'reset'],
    ['pooled stream reset: pool closed', 'reset'],
    ['read ECONNRESET', 'reset'],
    ['something else', 'failed'],
    [42, 'failed'],
  ] as const)('classes a failed send of "%s" as %s', (failure, outcome) => {
    expect(swmChangeNoticeFailure(typeof failure === 'string' ? new Error(failure) : failure)).toBe(outcome);
  });
});

describe('the owner\'s notifier', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function notifier(overrides: Partial<SwmChangeNotifierPorts> = {}) {
    const deliveries: Array<{ notice: SwmChangeNoticeV1; recipients: readonly string[] }> = [];
    const log = vi.fn();
    const ports: SwmChangeNotifierPorts = {
      ownsPublicGraph: async () => true,
      followers: async () => [MEMBER_1, MEMBER_2, MEMBER_3, OWNER, MEMBER_2],
      deliver: async (delivered, recipients) => {
        deliveries.push({ notice: delivered, recipients });
        return reachedAll(recipients);
      },
      selfPeerId: () => OWNER,
      log,
      ...overrides,
    };
    return { owner: new SwmChangeNotifier(ports), deliveries, log };
  }

  const change = (sourcePeerId: string, hint: string, subGraphName: string | null = 'notes'): SwmRemoteChange => ({
    contextGraphId: CG,
    subGraphName,
    hint,
    sourcePeerId,
  });

  it('tells every follower except itself and the share\'s source, once each', async () => {
    const { owner, deliveries, log } = notifier();

    owner.afterRemoteChange(change(MEMBER_1, 'op-1'));
    await owner.settled();

    expect(deliveries).toEqual([{ notice: notice('notes', 'op-1'), recipients: [MEMBER_2, MEMBER_3] }]);
    expect(log).toHaveBeenCalledWith(
      `SWM change notice for "${CG}" sub-graph "notes" (op-1): reached 2 of 2 follower(s)`,
    );
  });

  it('records the sources of a change as followers of a graph it owns, and only then', async () => {
    vi.useFakeTimers();
    const noted: Array<[string, string]> = [];
    const owned = notifier({ noteFollower: (contextGraphId, peerId) => noted.push([contextGraphId, peerId]) });
    owned.owner.afterRemoteChange(change(MEMBER_1, 'op-1'));
    owned.owner.afterRemoteChange(change(MEMBER_2, 'op-2'));
    owned.owner.afterRemoteChange(change(MEMBER_3, 'op-3'));
    await vi.advanceTimersByTimeAsync(1_000);
    await owned.owner.settled();
    const notOwned = notifier({ ownsPublicGraph: async () => false, noteFollower: () => noted.push(['x', 'y']) });
    notOwned.owner.afterRemoteChange(change(MEMBER_1, 'op-1'));
    await notOwned.owner.settled();

    expect(noted).toEqual([[CG, MEMBER_1], [CG, MEMBER_2], [CG, MEMBER_3]]);
  });

  it('sends nothing for a graph it does not own, or without anyone to tell', async () => {
    const notOwner = notifier({ ownsPublicGraph: async () => false });
    notOwner.owner.afterRemoteChange(change(MEMBER_1, 'op-1'));
    await notOwner.owner.settled();
    const alone = notifier({ followers: async () => [MEMBER_1] });
    alone.owner.afterRemoteChange(change(MEMBER_1, 'op-1'));
    await alone.owner.settled();

    expect(notOwner.deliveries).toEqual([]);
    expect(alone.deliveries).toEqual([]);
  });

  it('coalesces the changes of one scope into one trailing notice with the latest change', async () => {
    vi.useFakeTimers();
    const { owner, deliveries } = notifier();

    owner.afterRemoteChange(change(MEMBER_1, 'op-1'));
    owner.afterRemoteChange(change(MEMBER_1, 'op-2'));
    owner.afterRemoteChange(change(MEMBER_1, 'op-3'));
    await owner.settled();
    expect(deliveries.map(({ notice: { hint } }) => hint)).toEqual(['op-1']);

    await vi.advanceTimersByTimeAsync(1_000);
    await owner.settled();
    expect(deliveries.map(({ notice: { hint } }) => hint)).toEqual(['op-1', 'op-3']);
    expect(deliveries[1]!.recipients).toEqual([MEMBER_2, MEMBER_3]);
  });

  it('tells every source of a coalesced notice about the others\' changes', async () => {
    vi.useFakeTimers();
    const { owner, deliveries } = notifier();

    owner.afterRemoteChange(change(MEMBER_1, 'op-1'));
    owner.afterRemoteChange(change(MEMBER_2, 'op-2'));
    owner.afterRemoteChange(change(MEMBER_3, 'op-3'));
    await vi.advanceTimersByTimeAsync(1_000);
    await owner.settled();

    expect(deliveries[1]!.recipients).toEqual([MEMBER_1, MEMBER_2, MEMBER_3]);
  });

  it('keeps scopes apart: the root and each sub-graph get their own notice', async () => {
    const { owner, deliveries, log } = notifier();

    owner.afterRemoteChange(change(MEMBER_1, 'op-1', null));
    owner.afterRemoteChange(change(MEMBER_2, 'op-2', 'drafts'));
    owner.afterRemoteChange(change(MEMBER_1, 'op-3'));
    await owner.settled();

    expect(deliveries.map(({ notice: { subGraphName, hint } }) => [subGraphName, hint])).toEqual([
      [null, 'op-1'],
      ['drafts', 'op-2'],
      ['notes', 'op-3'],
    ]);
    expect(log).toHaveBeenCalledWith(`SWM change notice for "${CG}" root (op-1): reached 2 of 2 follower(s)`);
  });

  it('logs a delivery that fails and stays usable', async () => {
    let fail = true;
    const { owner, deliveries, log } = notifier({
      deliver: async (delivered, recipients) => {
        if (fail) throw new Error('relay closed');
        deliveries.push({ notice: delivered, recipients });
        return reachedAll(recipients);
      },
    });

    owner.afterRemoteChange(change(MEMBER_1, 'op-1', 'one'));
    await owner.settled();
    fail = false;
    owner.afterRemoteChange(change(MEMBER_1, 'op-2', 'two'));
    await owner.settled();

    expect(log).toHaveBeenCalledWith(`SWM change notice for "${CG}" not delivered: relay closed`);
    expect(deliveries.map(({ notice: { hint } }) => hint)).toEqual(['op-2']);
  });

  it('forgets the oldest scopes past its memory, so their next change goes out at once', async () => {
    const { owner, deliveries } = notifier();

    for (let index = 0; index < 1_100; index += 1) owner.afterRemoteChange(change(MEMBER_1, `op-${index}`, `s${index}`));
    await owner.settled();
    owner.afterRemoteChange(change(MEMBER_1, 'again-0', 's0'));
    owner.afterRemoteChange(change(MEMBER_1, 'again-1099', 's1099'));
    await owner.settled();
    owner.stop();

    expect(deliveries).toHaveLength(1_101);
    expect(deliveries.at(-1)!.notice.hint).toBe('again-0');
  });

  it('drops a trailing notice and sends no more once stopped', async () => {
    vi.useFakeTimers();
    const { owner, deliveries } = notifier();

    owner.afterRemoteChange(change(MEMBER_1, 'op-1'));
    owner.afterRemoteChange(change(MEMBER_1, 'op-2'));
    owner.stop();
    owner.afterRemoteChange(change(MEMBER_2, 'op-3', 'drafts'));
    await vi.advanceTimersByTimeAsync(5_000);
    await owner.settled();

    expect(deliveries.map(({ notice: { hint } }) => hint)).toEqual(['op-1']);
  });
});

describe('the owner\'s resends to the followers a notice did not reach (#3421)', () => {
  // The change of an author that follows nothing here: every member is told.
  const AUTHOR = '12D3KooWAuthorOfTheChange';
  const change = (hint: string): SwmRemoteChange => ({ contextGraphId: CG, subGraphName: 'notes', hint, sourcePeerId: AUTHOR });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** An owner whose sends to a follower end as `script` says, one entry per send; past its script a send reaches it. */
  function scripted(script: Record<string, readonly SwmChangeNoticeOutcome[]>, overrides: Partial<SwmChangeNotifierPorts> = {}) {
    const attempts: Array<{ at: number; recipients: readonly string[] }> = [];
    const sends = new Map<string, number>();
    const log = vi.fn();
    const owner = new SwmChangeNotifier({
      ownsPublicGraph: async () => true,
      followers: async () => [MEMBER_1, MEMBER_2, MEMBER_3],
      deliver: async (_notice, recipients) => {
        attempts.push({ at: Date.now(), recipients });
        return recipients.map((peerId) => {
          const index = sends.get(peerId) ?? 0;
          sends.set(peerId, index + 1);
          return { peerId, outcome: script[peerId]?.[index] ?? 'reached' };
        });
      },
      selfPeerId: () => OWNER,
      log,
      ...overrides,
    });
    return { owner, attempts, log };
  }

  it('sends it again to those it did not reach, 3 s later and 15 s after that, and logs whom it missed and why', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const { owner, attempts, log } = scripted({
      [MEMBER_2]: ['timeout', 'reset', 'reset'],
      [MEMBER_3]: ['unreachable'],
    });

    owner.afterRemoteChange(change('op-1'));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(attempts).toEqual([{ at: started, recipients: [MEMBER_1, MEMBER_2, MEMBER_3] }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts.at(-1)).toEqual({ at: started + 3_000, recipients: [MEMBER_2, MEMBER_3] });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(attempts.at(-1)).toEqual({ at: started + 18_000, recipients: [MEMBER_2] });
    await vi.advanceTimersByTimeAsync(60_000);
    await owner.settled();

    expect(attempts).toHaveLength(3);
    expect(log.mock.calls).toEqual([[
      `SWM change notice for "${CG}" sub-graph "notes" (op-1): reached 2 of 3 follower(s), 1 on a resend; `
        + `not reached: ${MEMBER_2.slice(-8)}=reset`,
    ]]);
  });

  it('does not send it again to a follower without the protocol, and leaves out one known to lack it', async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const { owner, attempts, log } = scripted({ [MEMBER_2]: ['unsupported'] }, {
      supportsNotice: async (peerId) => {
        asked.push(peerId);
        if (peerId === MEMBER_1) throw new Error('peer store closed');
        return peerId === MEMBER_3 ? false : undefined;
      },
    });

    owner.afterRemoteChange(change('op-1'));
    await vi.advanceTimersByTimeAsync(60_000);
    await owner.settled();

    expect(asked).toEqual([MEMBER_1, MEMBER_2, MEMBER_3]);
    // Unknown support (a failed lookup included) is tried; a refused protocol is not tried again.
    expect(attempts.map(({ recipients }) => recipients)).toEqual([[MEMBER_1, MEMBER_2]]);
    expect(log).toHaveBeenCalledWith(
      `SWM change notice for "${CG}" sub-graph "notes" (op-1): reached 1 of 1 follower(s); 2 without the notice protocol`,
    );
  });

  it('names at most eight followers it missed and counts the rest', async () => {
    const followers = Array.from({ length: 11 }, (_, index) => `12D3KooWFollowerNumber${String(index).padStart(2, '0')}`);
    const { owner, log } = scripted(
      Object.fromEntries(followers.map((peerId) => [peerId, ['timeout', 'timeout', 'timeout'] as const])),
      { followers: async () => followers, resendDelaysMs: [0, 0] },
    );

    owner.afterRemoteChange(change('op-1'));
    await owner.settled();

    const named = followers.slice(0, 8).map((peerId) => `${peerId.slice(-8)}=timeout`).join(', ');
    expect(log).toHaveBeenCalledWith(
      `SWM change notice for "${CG}" sub-graph "notes" (op-1): reached 0 of 11 follower(s); not reached: ${named} (+3 more)`,
    );
  });

  it('leaves its resends to a newer notice of the same scope, which tells every follower', async () => {
    vi.useFakeTimers();
    const { owner, attempts, log } = scripted({ [MEMBER_2]: ['timeout', 'timeout', 'timeout', 'timeout'] });

    owner.afterRemoteChange(change('op-1'));
    await vi.advanceTimersByTimeAsync(1_000);
    owner.afterRemoteChange(change('op-2'));
    await vi.advanceTimersByTimeAsync(60_000);
    await owner.settled();

    expect(attempts.map(({ recipients }) => recipients)).toEqual([
      [MEMBER_1, MEMBER_2, MEMBER_3],
      [MEMBER_1, MEMBER_2, MEMBER_3],
      [MEMBER_2],
      [MEMBER_2],
    ]);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      `SWM change notice for "${CG}" sub-graph "notes" (op-1): reached 2 of 3 follower(s); `
        + `not reached: ${MEMBER_2.slice(-8)}=timeout; a newer notice takes over the resends`,
      `SWM change notice for "${CG}" sub-graph "notes" (op-2): reached 2 of 3 follower(s); `
        + `not reached: ${MEMBER_2.slice(-8)}=timeout`,
    ]);
  });

  it('keeps the resends of different scopes apart', async () => {
    vi.useFakeTimers();
    const { owner, attempts } = scripted({ [MEMBER_2]: ['timeout'] });

    owner.afterRemoteChange(change('op-1'));
    owner.afterRemoteChange({ ...change('op-2'), subGraphName: 'drafts' });
    await vi.advanceTimersByTimeAsync(60_000);
    await owner.settled();

    // The notes notice resends to member 2; the drafts notice reached it at once.
    expect(attempts.map(({ recipients }) => recipients)).toEqual([
      [MEMBER_1, MEMBER_2, MEMBER_3],
      [MEMBER_1, MEMBER_2, MEMBER_3],
      [MEMBER_2],
    ]);
  });

  it('ends a wait for a resend at once when stopped, and sends no more', async () => {
    vi.useFakeTimers();
    const { owner, attempts, log } = scripted({ [MEMBER_2]: ['timeout'] });

    owner.afterRemoteChange(change('op-1'));
    await vi.advanceTimersByTimeAsync(0);
    owner.stop();
    // No timer is advanced: without the stop the wait for the resend would hold this.
    await owner.settled();

    expect(attempts).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      `SWM change notice for "${CG}" sub-graph "notes" (op-1): reached 2 of 3 follower(s); not reached: ${MEMBER_2.slice(-8)}=timeout`,
    );
  });
});

describe('the recipients of a change', () => {
  const ports = (owned: boolean, noted: Array<[string, string]>) => ({
    ownsPublicGraph: async () => owned,
    followers: async () => [MEMBER_1, MEMBER_2, OWNER, MEMBER_2, MEMBER_3],
    noteFollower: (contextGraphId: string, peerId: string) => { noted.push([contextGraphId, peerId]); },
    selfPeerId: () => OWNER,
  });

  it('are the followers of a public graph it owns but itself and a lone source; the sources are recorded', async () => {
    const noted: Array<[string, string]> = [];

    expect(await swmChangeRecipients(ports(true, noted), CG, new Set([MEMBER_1]))).toEqual([MEMBER_2, MEMBER_3]);
    expect(await swmChangeRecipients(ports(true, noted), CG, new Set([MEMBER_1, MEMBER_2])))
      .toEqual([MEMBER_1, MEMBER_2, MEMBER_3]);
    expect(noted).toEqual([[CG, MEMBER_1], [CG, MEMBER_1], [CG, MEMBER_2]]);
  });

  it('are nobody for a graph it does not own, and no source is recorded', async () => {
    const noted: Array<[string, string]> = [];

    expect(await swmChangeRecipients(ports(false, noted), CG, new Set([MEMBER_1]))).toEqual([]);
    expect(noted).toEqual([]);
  });
});

describe('the follower\'s receiver', () => {
  function receiver(overrides: Partial<SwmChangeNoticeReceiverPorts> = {}) {
    const pulls: Array<{
      peerId: string;
      contextGraphId: string;
      finish: () => void;
      defer: () => void;
      fail: (error: Error) => void;
    }> = [];
    const log = vi.fn();
    const ports: SwmChangeNoticeReceiverPorts = {
      follows: async (contextGraphId) => contextGraphId === CG,
      acceptsSender: async (_contextGraphId, peerId) => peerId !== MEMBER_3,
      pull: (peerId, contextGraphId) => new Promise<'pulled' | 'deferred'>((resolve, reject) => {
        pulls.push({
          peerId,
          contextGraphId,
          finish: () => resolve('pulled'),
          defer: () => resolve('deferred'),
          fail: reject,
        });
      }),
      log,
      ...overrides,
    };
    return { follower: new SwmChangeNoticeReceiver(ports), pulls, log };
  }
  const bytes = (subGraphName: string | null = 'notes', hint = 'op-1', contextGraphId = CG) => (
    encodeSwmChangeNoticeV1({ contextGraphId, subGraphName, hint })
  );
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('pulls a followed graph from an accepted sender, and ignores the rest', async () => {
    const { follower, pulls } = receiver();

    expect(await follower.handle(new Uint8Array([1, 2]), OWNER)).toBe('invalid');
    expect(await follower.handle(bytes('notes', 'op-1', '0x2222222222222222222222222222222222222222/other'), OWNER))
      .toBe('not-followed');
    expect(await follower.handle(bytes(), MEMBER_3)).toBe('sender-not-accepted');
    expect(await follower.handle(bytes(), OWNER)).toBe('pulling');

    expect(pulls.map(({ peerId, contextGraphId }) => [peerId, contextGraphId])).toEqual([[OWNER, CG]]);
  });

  it('keeps one pull per graph and sender; the notices of any scope meanwhile share one more pull after it', async () => {
    const { follower, pulls } = receiver();

    expect(await follower.handle(bytes('notes', 'op-1'), OWNER)).toBe('pulling');
    expect(await follower.handle(bytes('drafts', 'op-2'), OWNER)).toBe('coalesced');
    expect(await follower.handle(bytes(null, 'op-3'), OWNER)).toBe('coalesced');
    expect(await follower.handle(bytes('notes', 'op-4'), MEMBER_1)).toBe('pulling');
    expect(pulls.map(({ peerId }) => peerId)).toEqual([OWNER, MEMBER_1]);

    pulls[0]!.finish();
    await tick();
    expect(pulls.map(({ peerId }) => peerId)).toEqual([OWNER, MEMBER_1, OWNER]);
    // A notice during the trailing pull: one more after it.
    expect(await follower.handle(bytes('drafts', 'op-5'), OWNER)).toBe('coalesced');
    pulls[2]!.finish();
    await tick();
    expect(pulls.map(({ peerId }) => peerId)).toEqual([OWNER, MEMBER_1, OWNER, OWNER]);

    pulls[3]!.finish();
    pulls[1]!.finish();
    await follower.settled();
    expect(pulls).toHaveLength(4);
    expect(await follower.handle(bytes('notes', 'op-6'), OWNER)).toBe('pulling');
  });

  it('admits a trailing pull again: none once the graph is not followed or the sender not accepted', async () => {
    let following = true;
    let accepted = true;
    const { follower, pulls } = receiver({ follows: async () => following, acceptsSender: async () => accepted });

    await follower.handle(bytes('notes', 'op-1'), OWNER);
    expect(await follower.handle(bytes('drafts', 'op-2'), OWNER)).toBe('coalesced');
    following = false;
    pulls[0]!.finish();
    await follower.settled();
    expect(pulls).toHaveLength(1);

    following = true;
    expect(await follower.handle(bytes('notes', 'op-3'), OWNER)).toBe('pulling');
    expect(await follower.handle(bytes('drafts', 'op-4'), OWNER)).toBe('coalesced');
    accepted = false;
    pulls[1]!.finish();
    await follower.settled();
    expect(pulls).toHaveLength(2);
  });

  it('tries a deferred pull again after each pause, joined by the notices meanwhile, then leaves it to the periodic sync', async () => {
    const pauses: Array<{ ms: number; resume: () => void }> = [];
    const { follower, pulls } = receiver({
      deferredRetryDelaysMs: [2_000, 5_000],
      sleep: (ms) => new Promise<void>((resume) => { pauses.push({ ms, resume }); }),
    });

    await follower.handle(bytes('notes', 'op-1'), OWNER);
    pulls[0]!.defer();
    await tick();
    expect(pauses.map(({ ms }) => ms)).toEqual([2_000]);
    expect(await follower.handle(bytes('drafts', 'op-2'), OWNER)).toBe('coalesced');
    pauses[0]!.resume();
    await tick();
    expect(pulls).toHaveLength(2);
    pulls[1]!.defer();
    await tick();
    pauses[1]!.resume();
    await tick();
    pulls[2]!.defer();
    await follower.settled();

    expect(pulls).toHaveLength(3);
    expect(pauses.map(({ ms }) => ms)).toEqual([2_000, 5_000]);
    expect(await follower.handle(bytes(), OWNER)).toBe('pulling');
  });

  it('starts nothing once stopped: no notice is handled, and no trailing pull or retry runs', async () => {
    const pauses: number[] = [];
    const { follower, pulls } = receiver({
      sleep: (ms) => {
        pauses.push(ms);
        return new Promise<void>(() => {});
      },
    });

    await follower.handle(bytes('notes', 'op-1'), OWNER);
    await follower.handle(bytes('notes', 'op-1'), MEMBER_1);
    expect(await follower.handle(bytes('drafts', 'op-2'), OWNER)).toBe('coalesced');
    pulls[1]!.defer();
    await tick();
    expect(pauses).toEqual([2_000]);
    follower.stop();
    pulls[0]!.finish();
    await follower.settled();

    expect(pulls).toHaveLength(2);
    expect(await follower.handle(bytes(), OWNER)).toBe('stopped');
  });

  it('logs a failed pull and frees its graph', async () => {
    const { follower, pulls, log } = receiver();

    await follower.handle(bytes(), OWNER);
    pulls[0]!.fail(new Error('stream reset'));
    await follower.settled();

    expect(log).toHaveBeenCalledWith(`SWM change notice pull of "${CG}" from ${OWNER.slice(-8)} failed: stream reset`);
    expect(await follower.handle(bytes(), OWNER)).toBe('pulling');
  });

  it('ends the pulls of a graph when admitting the next one fails, and frees the graph', async () => {
    let checks = 0;
    const { follower, pulls, log } = receiver({
      follows: async () => {
        checks += 1;
        if (checks === 3) throw new Error('store closed');
        return true;
      },
    });

    await follower.handle(bytes('notes', 'op-1'), OWNER);
    await follower.handle(bytes('drafts', 'op-2'), OWNER);
    pulls[0]!.finish();
    await follower.settled();

    expect(pulls).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(`SWM change notice pulls of "${CG}" from ${OWNER.slice(-8)} stopped: store closed`);
    expect(await follower.handle(bytes(), OWNER)).toBe('pulling');
  });

  it('drops a peer\'s notices over its limit in one window, and only that peer\'s', async () => {
    let now = 0;
    const { follower } = receiver({ perPeerLimit: 2, perPeerWindowMs: 60_000, now: () => now });

    expect(await follower.handle(bytes('a'), OWNER)).toBe('pulling');
    expect(await follower.handle(bytes('b'), OWNER)).toBe('coalesced');
    expect(await follower.handle(bytes('c'), OWNER)).toBe('rate-limited');
    expect(await follower.handle(bytes('c'), MEMBER_1)).toBe('pulling');
    now = 60_000;
    expect(await follower.handle(bytes('d'), OWNER)).toBe('coalesced');
  });

  it('forgets the counts of the longest silent peers past its memory', async () => {
    const { follower } = receiver({ perPeerLimit: 1, follows: async () => false });

    expect(await follower.handle(bytes(), 'peer-0')).toBe('not-followed');
    expect(await follower.handle(bytes(), 'peer-0')).toBe('rate-limited');
    for (let index = 1; index <= 1_024; index += 1) await follower.handle(bytes(), `peer-${index}`);

    expect(await follower.handle(bytes(), 'peer-0')).toBe('not-followed');
  });

  it('pulls from at most 64 graph and sender pairs at once', async () => {
    const { follower } = receiver({ acceptsSender: async () => true });

    for (let index = 0; index < 64; index += 1) {
      expect(await follower.handle(bytes('notes', 'op-1'), `peer-${index}`)).toBe('pulling');
    }
    expect(await follower.handle(bytes('notes', 'op-1'), 'peer-64')).toBe('busy');
    expect(await follower.handle(bytes('drafts', 'op-2'), 'peer-0')).toBe('coalesced');
  });
});

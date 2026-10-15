/**
 * The shared-memory change notice of a public graph's owner (#1611): its wire
 * form, the owner's coalesced fan-out, and the follower's gated, coalesced,
 * rate-limited pull. The agent wiring is covered end to end in
 * `e2e-swm-relay-only.test.ts`.
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
  swmChangeNoticeHint,
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

  it('counts the recipients that accepted the stream', async () => {
    const send = vi.fn(async (peerId: string) => {
      if (peerId === MEMBER_2) throw new Error('protocol selection failed');
    });

    expect(await sendSwmChangeNotice(notice(), [MEMBER_1, MEMBER_2, MEMBER_3], send)).toBe(2);
    expect(send).toHaveBeenCalledTimes(3);
    expect(decodeSwmChangeNoticeV1(send.mock.calls[0]![1] as unknown as Uint8Array)).toEqual(notice());
  });
});

describe('the owner\'s notifier', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function notifier(overrides: Partial<SwmChangeNotifierPorts<string | undefined>> = {}) {
    const deliveries: Array<{ change: SwmRemoteChange<string | undefined>; recipients: readonly string[] }> = [];
    const log = vi.fn();
    const ports: SwmChangeNotifierPorts<string | undefined> = {
      ownsPublicGraph: async () => true,
      followers: async () => [MEMBER_1, MEMBER_2, MEMBER_3, OWNER, MEMBER_2],
      deliver: async (change, recipients) => {
        deliveries.push({ change, recipients });
        return recipients.length;
      },
      selfPeerId: () => OWNER,
      log,
      ...overrides,
    };
    return { owner: new SwmChangeNotifier(ports), deliveries, log };
  }

  const change = (sourcePeerId: string, hint: string, lane = '', subGraphName: string | null = 'notes'): SwmRemoteChange<string | undefined> => ({
    contextGraphId: CG,
    subGraphName,
    hint,
    sourcePeerId,
    lane,
    detail: lane === '' ? undefined : `head-${hint}`,
  });

  it('tells every follower except itself and the share\'s source, once each', async () => {
    const { owner, deliveries, log } = notifier();

    owner.afterRemoteChange(change(MEMBER_1, 'op-1'));
    await owner.settled();

    expect(deliveries).toEqual([{ change: change(MEMBER_1, 'op-1'), recipients: [MEMBER_2, MEMBER_3] }]);
    expect(log).toHaveBeenCalledWith(
      `SWM change notice for "${CG}" sub-graph "notes" (op-1): reached 2 of 2 follower(s)`,
    );
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

  it('coalesces the changes of one lane into one trailing delivery with the latest change', async () => {
    vi.useFakeTimers();
    const { owner, deliveries } = notifier();

    owner.afterRemoteChange(change(MEMBER_1, 'op-1'));
    owner.afterRemoteChange(change(MEMBER_1, 'op-2'));
    owner.afterRemoteChange(change(MEMBER_1, 'op-3'));
    await owner.settled();
    expect(deliveries.map(({ change: { hint } }) => hint)).toEqual(['op-1']);

    await vi.advanceTimersByTimeAsync(1_000);
    await owner.settled();
    expect(deliveries.map(({ change: { hint } }) => hint)).toEqual(['op-1', 'op-3']);
    expect(deliveries[1]!.recipients).toEqual([MEMBER_2, MEMBER_3]);
  });

  it('tells every source of a coalesced delivery about the others\' changes', async () => {
    vi.useFakeTimers();
    const { owner, deliveries } = notifier();

    owner.afterRemoteChange(change(MEMBER_1, 'op-1'));
    owner.afterRemoteChange(change(MEMBER_2, 'op-2'));
    owner.afterRemoteChange(change(MEMBER_3, 'op-3'));
    await vi.advanceTimersByTimeAsync(1_000);
    await owner.settled();

    expect(deliveries[1]!.recipients).toEqual([MEMBER_1, MEMBER_2, MEMBER_3]);
  });

  it('keeps lanes apart: the root heads of two authors and a sub-graph each get their own delivery', async () => {
    const { owner, deliveries } = notifier();

    owner.afterRemoteChange(change(MEMBER_1, 'h-1', '0xauthor-one', null));
    owner.afterRemoteChange(change(MEMBER_2, 'h-2', '0xauthor-two', null));
    owner.afterRemoteChange(change(MEMBER_1, 'op-1'));
    await owner.settled();

    expect(deliveries.map(({ change: { hint, detail } }) => [hint, detail])).toEqual([
      ['h-1', 'head-h-1'],
      ['h-2', 'head-h-2'],
      ['op-1', undefined],
    ]);
  });

  it('logs a delivery that fails and stays usable', async () => {
    let fail = true;
    const { owner, deliveries, log } = notifier({
      deliver: async (delivered, recipients) => {
        if (fail) throw new Error('relay closed');
        deliveries.push({ change: delivered, recipients });
        return recipients.length;
      },
    });

    owner.afterRemoteChange(change(MEMBER_1, 'op-1', '', 'one'));
    await owner.settled();
    fail = false;
    owner.afterRemoteChange(change(MEMBER_1, 'op-2', '', 'two'));
    await owner.settled();

    expect(log).toHaveBeenCalledWith(`SWM change notice for "${CG}" not delivered: relay closed`);
    expect(deliveries.map(({ change: { hint } }) => hint)).toEqual(['op-2']);
  });

  it('forgets the oldest lanes past its memory, so their next change goes out at once', async () => {
    const { owner, deliveries } = notifier();

    for (let index = 0; index < 1_100; index += 1) owner.afterRemoteChange(change(MEMBER_1, `op-${index}`, '', `s${index}`));
    await owner.settled();
    owner.afterRemoteChange(change(MEMBER_1, 'again-0', '', 's0'));
    owner.afterRemoteChange(change(MEMBER_1, 'again-1099', '', 's1099'));
    await owner.settled();
    owner.stop();

    expect(deliveries).toHaveLength(1_101);
    expect(deliveries.at(-1)!.change.hint).toBe('again-0');
  });

  it('drops a trailing delivery when stopped', async () => {
    vi.useFakeTimers();
    const { owner, deliveries } = notifier();

    owner.afterRemoteChange(change(MEMBER_1, 'op-1'));
    owner.afterRemoteChange(change(MEMBER_1, 'op-2'));
    owner.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await owner.settled();

    expect(deliveries.map(({ change: { hint } }) => hint)).toEqual(['op-1']);
  });
});

describe('the follower\'s receiver', () => {
  function receiver(overrides: Partial<SwmChangeNoticeReceiverPorts> = {}) {
    const pulls: Array<{ peerId: string; notice: SwmChangeNoticeV1; finish: () => void; fail: (error: Error) => void }> = [];
    const log = vi.fn();
    const ports: SwmChangeNoticeReceiverPorts = {
      follows: async (contextGraphId) => contextGraphId === CG,
      acceptsSender: async (_contextGraphId, peerId) => peerId !== MEMBER_3,
      pull: (peerId, pulled) => new Promise<void>((resolve, reject) => {
        pulls.push({ peerId, notice: pulled, finish: resolve, fail: reject });
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

  it('pulls a followed graph\'s scope from an accepted sender, and ignores the rest', async () => {
    const { follower, pulls } = receiver();

    expect(await follower.handle(new Uint8Array([1, 2]), OWNER)).toBe('invalid');
    expect(await follower.handle(bytes('notes', 'op-1', '0x2222222222222222222222222222222222222222/other'), OWNER))
      .toBe('not-followed');
    expect(await follower.handle(bytes(), MEMBER_3)).toBe('sender-not-accepted');
    expect(await follower.handle(bytes(), OWNER)).toBe('pulling');

    expect(pulls.map(({ peerId, notice: pulled }) => [peerId, pulled])).toEqual([[OWNER, notice()]]);
  });

  it('runs one pull per scope, and one more after it for the notices that came meanwhile', async () => {
    const { follower, pulls } = receiver();

    expect(await follower.handle(bytes('notes', 'op-1'), OWNER)).toBe('pulling');
    expect(await follower.handle(bytes('notes', 'op-2'), OWNER)).toBe('coalesced');
    expect(await follower.handle(bytes('notes', 'op-3'), MEMBER_1)).toBe('coalesced');
    expect(await follower.handle(bytes(null, 'h-1'), OWNER)).toBe('pulling');
    expect(pulls).toHaveLength(2);

    pulls[0]!.finish();
    await tick();
    expect(pulls.map(({ peerId, notice: { hint } }) => [peerId, hint])).toEqual([
      [OWNER, 'op-1'],
      [OWNER, 'h-1'],
      [MEMBER_1, 'op-3'],
    ]);

    pulls[2]!.finish();
    pulls[1]!.finish();
    await follower.settled();
    expect(await follower.handle(bytes('notes', 'op-4'), OWNER)).toBe('pulling');
    expect(pulls).toHaveLength(4);
  });

  it('logs a failed pull and frees its scope', async () => {
    const { follower, pulls, log } = receiver();

    await follower.handle(bytes(), OWNER);
    pulls[0]!.fail(new Error('stream reset'));
    await follower.settled();

    expect(log).toHaveBeenCalledWith(`SWM change notice pull of "${CG}" from ${OWNER.slice(-8)} failed: stream reset`);
    expect(await follower.handle(bytes(), OWNER)).toBe('pulling');
  });

  it('drops a peer\'s notices over its limit in one window, and only that peer\'s', async () => {
    let now = 0;
    const { follower } = receiver({ perPeerLimit: 2, perPeerWindowMs: 60_000, now: () => now });

    expect(await follower.handle(bytes('a'), OWNER)).toBe('pulling');
    expect(await follower.handle(bytes('b'), OWNER)).toBe('pulling');
    expect(await follower.handle(bytes('c'), OWNER)).toBe('rate-limited');
    expect(await follower.handle(bytes('c'), MEMBER_1)).toBe('pulling');
    now = 60_000;
    expect(await follower.handle(bytes('d'), OWNER)).toBe('pulling');
  });

  it('forgets the counts of the longest silent peers past its memory', async () => {
    const { follower } = receiver({ perPeerLimit: 1, follows: async () => false });

    expect(await follower.handle(bytes(), 'peer-0')).toBe('not-followed');
    expect(await follower.handle(bytes(), 'peer-0')).toBe('rate-limited');
    for (let index = 1; index <= 1_024; index += 1) await follower.handle(bytes(), `peer-${index}`);

    expect(await follower.handle(bytes(), 'peer-0')).toBe('not-followed');
  });

  it('pulls at most 64 scopes at once', async () => {
    const { follower } = receiver({ perPeerLimit: 1_000 });

    for (let index = 0; index < 64; index += 1) {
      expect(await follower.handle(bytes(`scope-${index}`), OWNER)).toBe('pulling');
    }
    expect(await follower.handle(bytes('one-more'), OWNER)).toBe('busy');
  });
});

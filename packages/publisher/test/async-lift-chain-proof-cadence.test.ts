// SPDX-License-Identifier: Apache-2.0

/**
 * PR #2373 — the held-job chain-proof CADENCE, tested through the real dispatcher (r3
 * 3880005935: an independent scheduling-focused suite, split out of the general dispatch
 * module). The pure ladder arithmetic lives in chain-proof-retry-schedule.test.ts; these rows
 * prove the WIRING: phase-driven ceilings, shared attempt accounting, jitter bounds, and the
 * stale-successor no-op, each observed via which passes actually re-ask the resolver.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTROL_GRAPH_URI,
  serializeJobRecord,
} from '../src/async-lift-control-plane.js';
import { createAsyncLift2270Harness } from './_helpers/async-lift-2270-harness.js';
import { kaVmPublishRequest } from './_helpers/ka-vm-publish.js';

describe('GH#2270 chain-proof cadence', () => {
  const h = createAsyncLift2270Harness();

  beforeEach(() => h.reset());

  describe('the awaiting-confirmations phase tightens only the re-ask ceiling — scheduling only', () => {
    // r1 (3879708085 / 3879708091 / 3879708110) — the ladder base for the awaiting-confirmations
    // cadence is capped at ceiling/(1+jitter) = 96s so 120s is the TRUE post-jitter bound; growth
    // and the ONE shared attempt count are unchanged; and a verdict rejected at the stale-job
    // boundary may not touch the successor's schedule at all. `rand: () => 0` rows make the
    // ladder arithmetic exact up to the harness clock's one-tick-per-read drift, absorbed by
    // 1-second margins around every boundary.

    function phasedResolver(pick: (ask: number) => 'awaiting-confirmations' | 'bare') {
      const asked: number[] = [];
      const resolver = async () => {
        asked.push(1);
        return pick(asked.length) === 'bare'
          ? ({ status: 'pending-mempool' } as const)
          : ({ status: 'pending-awaiting-confirmation' } as const);
      };
      return { asked, resolver };
    }

    async function heldPhasedJob(
      pick: (ask: number) => 'awaiting-confirmations' | 'bare',
      rand: () => number = () => 0,
    ) {
      const { asked, resolver } = phasedResolver(pick);
      const publisher = h.createPublisher({
        chainProofDispatchBatchSize: 1,
        rand,
        chainProofResolver: resolver,
      });
      const { jobId } = await h.failAfterRecordedTxHash(publisher, kaVmPublishRequest());
      return { publisher, jobId, asked };
    }

    it('an awaiting-confirmations verdict is re-asked within the 2-minute ceiling', async () => {
      const { publisher, jobId, asked } = await heldPhasedJob(() => 'awaiting-confirmations');
      await publisher.recover();
      for (const wait of [31_000, 61_000, 97_000]) {
        h.advance(wait);
        await publisher.recover();
      }
      expect(asked).toHaveLength(4);

      // Attempt 4 defers by min(240s, 96s base cap) = 96s; well inside 2 minutes.
      h.advance(97_000);
      await publisher.recover();
      expect(asked).toHaveLength(5);

      // Scheduling-only: five phased verdicts moved NOTHING.
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
    });

    it('a bare pending verdict keeps the 10-minute ceiling — the tight cap requires the phase', async () => {
      const { publisher, asked } = await heldPhasedJob(() => 'bare');
      await publisher.recover();
      for (const wait of [31_000, 61_000, 121_000]) {
        h.advance(wait);
        await publisher.recover();
      }
      expect(asked).toHaveLength(4);

      // Attempt 4 defers by min(240s, 600s) = 240s: at ~97s it is NOT due yet.
      h.advance(97_000);
      await publisher.recover();
      expect(asked).toHaveLength(4);

      // ...and the deferral is still a delay, not an eviction.
      h.advance(145_000);
      await publisher.recover();
      expect(asked).toHaveLength(5);
    });

    it('the phased ladder GROWS 30s → 60s → 96s — both sides of every due boundary', async () => {
      // 3879708085 — a constant per-attempt delay must fail here: the just-before probes sit
      // beyond a constant 30s but before the grown boundary.
      const { publisher, asked } = await heldPhasedJob(() => 'awaiting-confirmations');
      await publisher.recover();
      expect(asked).toHaveLength(1);

      h.advance(29_000);
      await publisher.recover();
      expect(asked).toHaveLength(1);
      h.advance(2_000);
      await publisher.recover();
      expect(asked).toHaveLength(2);

      h.advance(59_000);
      await publisher.recover();
      expect(asked).toHaveLength(2);
      h.advance(2_000);
      await publisher.recover();
      expect(asked).toHaveLength(3);

      h.advance(95_000);
      await publisher.recover();
      expect(asked).toHaveLength(3);
      h.advance(2_000);
      await publisher.recover();
      expect(asked).toHaveLength(4);
    });

    it('alternating phases share ONE attempt ladder; the phase changes only the ceiling', async () => {
      // 3879708085 — bare, phased, bare, phased: the ladder base runs 30s, 60s, 120s, 240s on
      // the shared count; the phase merely caps its own turns at 96s (attempt 4: 240 → 96).
      const { publisher, asked } = await heldPhasedJob(
        (ask) => (ask % 2 === 1 ? 'bare' : 'awaiting-confirmations'),
      );
      await publisher.recover();
      expect(asked).toHaveLength(1);

      h.advance(31_000);
      await publisher.recover();
      expect(asked).toHaveLength(2);

      h.advance(59_000);
      await publisher.recover();
      expect(asked).toHaveLength(2);
      h.advance(2_000);
      await publisher.recover();
      expect(asked).toHaveLength(3);

      h.advance(119_000);
      await publisher.recover();
      expect(asked).toHaveLength(3);
      h.advance(2_000);
      await publisher.recover();
      expect(asked).toHaveLength(4);

      h.advance(95_000);
      await publisher.recover();
      expect(asked).toHaveLength(4);
      h.advance(2_000);
      await publisher.recover();
      expect(asked).toHaveLength(5);
    });

    it('120 seconds is the ceiling AFTER jitter — rand at its maximum cannot exceed it', async () => {
      // 3879708091 — with rand()=1 the jittered delays run 37.5s, 75s, then exactly 120s
      // (96s base cap + 25% jitter). The old pre-jitter cap would schedule 150s here.
      const { publisher, asked } = await heldPhasedJob(() => 'awaiting-confirmations', () => 1);
      await publisher.recover();
      expect(asked).toHaveLength(1);

      h.advance(38_500);
      await publisher.recover();
      expect(asked).toHaveLength(2);
      h.advance(76_000);
      await publisher.recover();
      expect(asked).toHaveLength(3);

      h.advance(119_000);
      await publisher.recover();
      expect(asked).toHaveLength(3);
      h.advance(2_000);
      await publisher.recover();
      expect(asked).toHaveLength(4);
    });

    it('a re-failed successor starts its own ladder at the 30-second base, not the predecessor exponent', async () => {
      // r2 (3879930149) — the other half of the stale guarantee: the schedule entry the
      // predecessor accumulated (attempt count AND due time) must not seed the successor.
      // Attempts are climbed to 2, the third resolver call is parked while the record is
      // re-failed (fresh failedAt), and the successor's FIRST deferral must be the 30s base:
      // due at +31s, not at the predecessor's next exponent.
      let release!: () => void;
      const parked = new Promise<void>((resolve) => { release = resolve; });
      let asks = 0;
      const publisher = h.createPublisher({
        chainProofDispatchBatchSize: 1,
        rand: () => 0,
        chainProofResolver: async () => {
          asks += 1;
          if (asks === 3) await parked;
          return { status: 'pending-mempool' };
        },
      });
      const { jobId } = await h.failAfterRecordedTxHash(publisher, kaVmPublishRequest());

      await publisher.recover();
      h.advance(31_000);
      await publisher.recover();
      expect(asks).toBe(2);
      h.advance(61_000);
      const thirdPass = publisher.recover();
      while (asks < 3) await new Promise((resolve) => setTimeout(resolve, 5));

      const current = await publisher.getStatus(jobId);
      const successor = {
        ...current!,
        timestamps: { ...current!.timestamps, failedAt: (current!.timestamps as { failedAt: number }).failedAt + 1 },
      };
      const { jobRef, jobQuads } = serializeJobRecord(successor as never, DEFAULT_CONTROL_GRAPH_URI);
      await (h.store as unknown as {
        replaceSubject(graph: string, subject: string, quads: unknown): Promise<void>;
      }).replaceSubject(DEFAULT_CONTROL_GRAPH_URI, jobRef, jobQuads);

      release();
      await thirdPass;
      expect(asks).toBe(3);

      // Successor's first ask (immediate — the stale drop scheduled nothing).
      await publisher.recover();
      expect(asks).toBe(4);

      // Its first deferral is the BASE: not due at 29s...
      h.advance(29_000);
      await publisher.recover();
      expect(asks).toBe(4);
      // ...due just past 30s. The predecessor's ladder (next exponent 120s) would still be quiet.
      h.advance(2_000);
      await publisher.recover();
      expect(asks).toBe(5);
    });

    it.each([
      ['failedFromState', (t: Record<string, unknown>) => ({ ...t, failure: { ...(t.failure as object), failedFromState: 'included' } })],
      ['failure.code', (t: Record<string, unknown>) => ({ ...t, failure: { ...(t.failure as object), code: 'recovery_chain_unavailable' } })],
      ['failedAt absent', (t: Record<string, unknown>) => {
        const timestamps = { ...(t.timestamps as Record<string, unknown>) };
        delete timestamps.failedAt;
        return { ...t, timestamps };
      }],
      // r8 (3882533673) — the fourth component: TRANSACTION EVIDENCE. Only the broadcast hash
      // changes; failure state, code, and timestamps stay identical, so this case is red iff
      // `chainProofLookupFingerprint(lookup)` participates in the incarnation key.
      ['transaction evidence', (t: Record<string, unknown>) => ({
        ...t,
        broadcast: { ...(t.broadcast as object), txHash: `0x${'77'.repeat(32)}` },
      })],
    ] as const)(
      'every incarnation-key component discriminates: a mid-flight %s change makes the verdict stale',
      async (_component, mutate) => {
      // r7 (3882283845) — the production key (`heldChainProofIncarnationKey`) is exercised
      // field by field: while the resolver is in flight the record is replaced with a variant
      // differing in exactly ONE identity component, and the returning verdict is `not-found` —
      // the one that would RESET a create if the stale fence failed. The fence holding means:
      // the replacement stays `failed` (no reset applied), nothing is scheduled for it (the
      // very next pass asks about the successor immediately), and the run continues on the
      // successor's own incarnation.
      let releaseFirst!: () => void;
      const parked = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let asks = 0;
      const publisher = h.createPublisher({
        chainProofDispatchBatchSize: 1,
        rand: () => 0,
        chainProofResolver: async () => {
          asks += 1;
          if (asks === 1) {
            await parked;
            return { status: 'not-found' };
          }
          return { status: 'inconclusive' };
        },
      });
      const { jobId } = await h.failAfterRecordedTxHash(publisher, kaVmPublishRequest());

      const firstPass = publisher.recover();
      while (asks === 0) await new Promise((resolve) => setTimeout(resolve, 5));

      const current = await publisher.getStatus(jobId);
      const successor = mutate(current as unknown as Record<string, unknown>);
      const { jobRef, jobQuads } = serializeJobRecord(successor as never, DEFAULT_CONTROL_GRAPH_URI);
      await (h.store as unknown as {
        replaceSubject(graph: string, subject: string, quads: unknown): Promise<void>;
      }).replaceSubject(DEFAULT_CONTROL_GRAPH_URI, jobRef, jobQuads);

      releaseFirst();
      await firstPass;

      // The not-found verdict was discarded whole: no create reset, and nothing scheduled —
      // the successor is immediately due on its own incarnation.
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
      await publisher.recover();
      expect(asks).toBe(2);
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
    });

    it("a stale predecessor's late PENDING verdict cannot reset the successor's earned backoff", async () => {
      // r5 (3882010299) / r6 (🔴 3882186065) — honest scope: this row pins the stale-DROP for a
      // normal pending verdict (the replacement lands before A's re-read), not the re-read-to-
      // mutation window itself. That window is closed structurally, twice over: the mutation
      // happens inside the same claim transaction as the re-read, and the schedule is keyed by
      // incarnation so a cross-incarnation write is unrepresentable — the isolation is proven
      // directly by the schedule unit rows (echo-drop, foreign-settlement no-op).
      let releaseFirst!: () => void;
      const parked = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let asks = 0;
      const publisher = h.createPublisher({
        chainProofDispatchBatchSize: 1,
        rand: () => 0,
        chainProofResolver: async () => {
          asks += 1;
          if (asks === 1) await parked;
          return { status: 'pending-mempool' };
        },
      });
      const { jobId } = await h.failAfterRecordedTxHash(publisher, kaVmPublishRequest());

      const firstPass = publisher.recover();
      while (asks === 0) await new Promise((resolve) => setTimeout(resolve, 5));

      const current = await publisher.getStatus(jobId);
      const successor = {
        ...current!,
        timestamps: { ...current!.timestamps, failedAt: (current!.timestamps as { failedAt: number }).failedAt + 1 },
      };
      const { jobRef, jobQuads } = serializeJobRecord(successor as never, DEFAULT_CONTROL_GRAPH_URI);
      await (h.store as unknown as {
        replaceSubject(graph: string, subject: string, quads: unknown): Promise<void>;
      }).replaceSubject(DEFAULT_CONTROL_GRAPH_URI, jobRef, jobQuads);

      await publisher.recover();
      expect(asks).toBe(2);

      releaseFirst();
      await firstPass;

      h.advance(29_000);
      await publisher.recover();
      expect(asks).toBe(2);
      h.advance(2_000);
      await publisher.recover();
      expect(asks).toBe(3);
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
    });

    it("a stale predecessor's late EXCEPTION cannot reset the successor's earned backoff", async () => {
      // r4 (3881841010) — the mutation-side twin of the stale guarantees: pass A's resolver call
      // stalls, the record is re-failed, the successor earns its 30s deferral on its own pass,
      // and THEN A's call rejects. The catch-path deferral is unverified, so it must land on
      // nothing: the successor stays quiet until ITS due time, and is asked exactly then.
      let failFirst!: (err: Error) => void;
      const parked = new Promise<never>((_resolve, reject) => { failFirst = reject; });
      let asks = 0;
      const publisher = h.createPublisher({
        chainProofDispatchBatchSize: 1,
        rand: () => 0,
        chainProofResolver: async () => {
          asks += 1;
          if (asks === 1) await parked;
          return { status: 'pending-mempool' };
        },
      });
      const { jobId } = await h.failAfterRecordedTxHash(publisher, kaVmPublishRequest());

      const firstPass = publisher.recover();
      while (asks === 0) await new Promise((resolve) => setTimeout(resolve, 5));

      const current = await publisher.getStatus(jobId);
      const successor = {
        ...current!,
        timestamps: { ...current!.timestamps, failedAt: (current!.timestamps as { failedAt: number }).failedAt + 1 },
      };
      const { jobRef, jobQuads } = serializeJobRecord(successor as never, DEFAULT_CONTROL_GRAPH_URI);
      await (h.store as unknown as {
        replaceSubject(graph: string, subject: string, quads: unknown): Promise<void>;
      }).replaceSubject(DEFAULT_CONTROL_GRAPH_URI, jobRef, jobQuads);

      // The successor earns its own schedule: asked immediately (stale pass wrote nothing yet),
      // deferred 30s at attempt 1.
      await publisher.recover();
      expect(asks).toBe(2);

      // NOW the predecessor's resolver call rejects; its catch-path deferral is unverified.
      failFirst(new Error('predecessor resolver died late'));
      await firstPass;

      // The successor's backoff is intact: quiet before its own due time...
      h.advance(29_000);
      await publisher.recover();
      expect(asks).toBe(2);
      // ...asked exactly past it. A leaked predecessor deferral would either have reset the
      // ladder (foreign identity -> immediately due, asked at 29s) or restarted attempts.
      h.advance(2_000);
      await publisher.recover();
      expect(asks).toBe(3);
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
    });

    it('a verdict rejected as STALE leaves the successor record unscheduled', async () => {
      // 3879708110 — the held job is replaced while its resolver is in flight (fresh failedAt =
      // a re-failed successor). The identity boundary drops the verdict; the successor must not
      // inherit its scheduling either: with no deferral written, the very next pass asks again.
      let release!: () => void;
      const parked = new Promise<void>((resolve) => { release = resolve; });
      let asks = 0;
      const publisher = h.createPublisher({
        chainProofDispatchBatchSize: 1,
        rand: () => 0,
        chainProofResolver: async () => {
          asks += 1;
          if (asks === 1) await parked;
          return { status: 'pending-awaiting-confirmation' };
        },
      });
      const { jobId } = await h.failAfterRecordedTxHash(publisher, kaVmPublishRequest());

      const firstPass = publisher.recover();
      while (asks === 0) await new Promise((resolve) => setTimeout(resolve, 5));

      const current = await publisher.getStatus(jobId);
      const successor = {
        ...current!,
        timestamps: { ...current!.timestamps, failedAt: (current!.timestamps as { failedAt: number }).failedAt + 1 },
      };
      const { jobRef, jobQuads } = serializeJobRecord(successor as never, DEFAULT_CONTROL_GRAPH_URI);
      await (h.store as unknown as {
        replaceSubject(graph: string, subject: string, quads: unknown): Promise<void>;
      }).replaceSubject(DEFAULT_CONTROL_GRAPH_URI, jobRef, jobQuads);

      release();
      await firstPass;
      expect(asks).toBe(1);

      // No clock advance: a deferral leaked from the stale verdict would make this pass skip
      // the job. The successor earns its own first ask immediately.
      await publisher.recover();
      expect(asks).toBe(2);
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
    });
  });

  describe('pass ordering and residue through the real reconciliation path (r6)', () => {
    it("a pass stalled BEFORE dispatch cannot outrank a later pass's newer snapshot", async () => {
      // r6 (🔴 3883453447 follow-up) — the publisher-level inversion regression: pass A
      // snapshots the predecessor incarnation, stalls in an earlier reconciliation lane, the
      // record is re-failed, pass B snapshots and defers the successor for its 30s base — and
      // only THEN pass A reaches the dispatcher. Its token was issued at its SNAPSHOT, so its
      // observation is refused: no resolver call, and the successor's backoff runs in full. A
      // regression that issues the token at the dispatcher hands stale A the newer token,
      // erases B's deferral, and re-asks before 30s — both assertions below go red.
      let releaseStalled!: () => void;
      const stalled = new Promise<void>((resolve) => { releaseStalled = resolve; });
      let signalStalled!: () => void;
      const stalledEntered = new Promise<void>((resolve) => { signalStalled = resolve; });
      let asks = 0;
      const publisher = h.createPublisher({
        chainProofDispatchBatchSize: 1,
        rand: () => 0,
        chainProofResolver: async () => {
          asks += 1;
          return { status: 'pending-mempool' };
        },
      });
      const { jobId } = await h.failAfterRecordedTxHash(publisher, kaVmPublishRequest());

      // Stall pass A between its snapshot and its chain-proof dispatch — the window the
      // ordering claim is about — by parking the first recovery-lane call on its way through.
      const impl = publisher as unknown as {
        recoverInterruptedPreBroadcastJobs(inventory: unknown): Promise<number>;
      };
      const originalLane = impl.recoverInterruptedPreBroadcastJobs.bind(publisher);
      let firstLaneCall = true;
      impl.recoverInterruptedPreBroadcastJobs = async (inventory: unknown) => {
        if (firstLaneCall) {
          firstLaneCall = false;
          signalStalled();
          await stalled;
        }
        return originalLane(inventory);
      };

      const passA = publisher.recover();
      // r8 (🔴 3883812279) — an explicit handshake, not a sleep: the patched lane runs strictly
      // AFTER acquisition, so this await proves pass A holds its predecessor snapshot (and its
      // token) before the record is replaced below.
      await stalledEntered;

      const current = await publisher.getStatus(jobId);
      const successor = {
        ...current!,
        timestamps: { ...current!.timestamps, failedAt: (current!.timestamps as { failedAt: number }).failedAt + 1 },
      };
      const { jobRef, jobQuads } = serializeJobRecord(successor as never, DEFAULT_CONTROL_GRAPH_URI);
      await (h.store as unknown as {
        replaceSubject(graph: string, subject: string, quads: unknown): Promise<void>;
      }).replaceSubject(DEFAULT_CONTROL_GRAPH_URI, jobRef, jobQuads);

      await publisher.recover(); // pass B: newer snapshot, successor asked and deferred 30s
      expect(asks).toBe(1);

      releaseStalled();
      await passA; // stale A reaches the dispatcher LAST — refused by its older token
      expect(asks).toBe(1);

      h.advance(29_000);
      await publisher.recover();
      expect(asks).toBe(1); // the successor's earned backoff ran in full
      h.advance(2_000);
      await publisher.recover();
      expect(asks).toBe(2);
    });

    it('inventory acquisition is a linearization boundary — concurrent passes cannot interleave it', async () => {
      // r6 (🔴 3883453447) — overlapping list() reads may RESOLVE out of store-side capture
      // order, so the seam serializes acquisitions: the second pass's read must not start
      // until the first pass's snapshot (and its token) is complete, even when the first
      // read is slow. Interleaved enters here mean tokens can order by completion again.
      const publisher = h.createPublisher({
        chainProofDispatchBatchSize: 1,
        rand: () => 0,
        chainProofResolver: async () => ({ status: 'pending-mempool' }),
      });
      const events: string[] = [];
      const originalList = publisher.list.bind(publisher);
      let firstListCall = true;
      (publisher as { list: typeof publisher.list }).list = async (filter) => {
        events.push('enter');
        if (firstListCall) {
          firstListCall = false;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const result = await originalList(filter);
        events.push('exit');
        return result;
      };
      await Promise.all([publisher.recover(), publisher.recover()]);
      expect(events).toEqual(['enter', 'exit', 'enter', 'exit']);
    });

    it("recover() itself sweeps residue a truncated pass left behind", async () => {
      // r8 (🟡 3883812096) — the dispatcher's prune CALL is the wiring under test (the sweep
      // semantics are the schedule's own rows): batch size 0 lets a pass observe the held job
      // (installing its entry) without ever dispatching the turn, and the job is then cleared,
      // so no dispatch can ever release the slot. The next recover()'s sweep must collect it.
      const publisher = h.createPublisher({
        chainProofDispatchBatchSize: 0,
        rand: () => 0,
        chainProofResolver: async () => ({ status: 'pending-mempool' }),
      });
      const { jobId } = await h.failAfterRecordedTxHash(publisher, kaVmPublishRequest());
      const schedule = (publisher as unknown as {
        chainProofRetrySchedule: { retainedEntryCount(): number };
      }).chainProofRetrySchedule;

      await publisher.recover(); // observed + installed, batch 0: never dispatched
      expect(schedule.retainedEntryCount()).toBe(1);

      await publisher.clearTerminalJob(jobId, { pendingTransactionOverride: { requestedBy: 'operator' } });
      await publisher.recover(); // empty held population: the sweep collects the residue
      expect(schedule.retainedEntryCount()).toBe(0);
    });

    it('a failed inventory acquisition does not poison the chain — the next pass reads fresh', async () => {
      // r7 (🟡 3883690945) — the rejection handler on the acquisition chain is load-bearing:
      // the chain must carry only settlement, never the failure. A one-shot list() failure
      // rejects its own pass; the NEXT pass performs a fresh read (not the memoized rejection)
      // and real dispatch work proceeds.
      let asks = 0;
      const publisher = h.createPublisher({
        chainProofDispatchBatchSize: 1,
        rand: () => 0,
        chainProofResolver: async () => {
          asks += 1;
          return { status: 'pending-mempool' };
        },
      });
      const { jobId } = await h.failAfterRecordedTxHash(publisher, kaVmPublishRequest());

      const originalList = publisher.list.bind(publisher);
      let listCalls = 0;
      let failNext = true;
      (publisher as { list: typeof publisher.list }).list = async (filter) => {
        listCalls += 1;
        if (failNext) {
          failNext = false;
          throw new Error('transient store read failure');
        }
        return originalList(filter);
      };

      await expect(publisher.recover()).rejects.toThrow('transient store read failure');
      const callsAfterFailure = listCalls;
      await publisher.recover();
      expect(listCalls).toBe(callsAfterFailure + 1); // a fresh read, not a replayed rejection
      expect(asks).toBe(1); // the held job was actually dispatched
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
    });

    it('a HUNG inventory read cannot block later passes — the acquisition wait is bounded', async () => {
      // r10 (🔴 3883959795) — one non-settling store read must degrade ordering, not
      // availability: with an unbounded chain, every later recover() queues behind the hung
      // read forever, the opposite of the documented fresh-pass contract. The bounded wait
      // releases the successor at the cap, and the successor's own settlement replaces the
      // chain so the hung acquisition wedges nobody after it either.
      let asks = 0;
      const publisher = h.createPublisher({
        chainProofDispatchBatchSize: 1,
        rand: () => 0,
        reconciliationAcquisitionWaitCapMs: 50,
        chainProofResolver: async () => {
          asks += 1;
          return { status: 'pending-mempool' };
        },
      });
      const { jobId } = await h.failAfterRecordedTxHash(publisher, kaVmPublishRequest());

      const originalList = publisher.list.bind(publisher);
      let firstListCall = true;
      (publisher as { list: typeof publisher.list }).list = async (filter) => {
        if (firstListCall) {
          firstListCall = false;
          return new Promise(() => undefined); // a store read that never settles
        }
        return originalList(filter);
      };

      const hung = publisher.recover(); // acquisition 1: wedged inside list() forever
      void hung;
      await publisher.recover(); // must wait at most the 50ms cap, then acquire fresh
      expect(asks).toBe(1); // ...and do real work: the held job was dispatched
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
      h.advance(31_000);
      await publisher.recover(); // the chain is owned by settled acquisitions again
      expect(asks).toBe(2); // past the 30s deferral: the lane keeps running after the hung head
    });

    it('a held job cleared while its verdict is in flight releases its schedule slot', async () => {
      // r6 (🔴 3883453613) — the record is DELETED (operator clear) while the resolver is in
      // flight; the locked re-read finds nothing. The turn must release its slot: without the
      // stale-branch settlement the ready() entry survives a job no pass will ever observe
      // again, and `retainedEntryCount` counts it forever.
      let release!: () => void;
      const parked = new Promise<void>((resolve) => { release = resolve; });
      let asks = 0;
      const publisher = h.createPublisher({
        chainProofDispatchBatchSize: 1,
        rand: () => 0,
        chainProofResolver: async () => {
          asks += 1;
          await parked;
          return { status: 'pending-mempool' };
        },
      });
      const { jobId } = await h.failAfterRecordedTxHash(publisher, kaVmPublishRequest());

      const firstPass = publisher.recover();
      while (asks === 0) await new Promise((resolve) => setTimeout(resolve, 5));

      // The real operator exit, serialized on the same claim lock the disposition uses.
      await publisher.clearTerminalJob(jobId, { pendingTransactionOverride: { requestedBy: 'operator' } });

      release();
      await firstPass;
      const schedule = (publisher as unknown as {
        chainProofRetrySchedule: { retainedEntryCount(): number };
      }).chainProofRetrySchedule;
      expect(schedule.retainedEntryCount()).toBe(0);
      expect(await publisher.getStatus(jobId)).toBeNull();
    });
  });
});

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

    it("a stale predecessor's late PENDING verdict cannot reset the successor's earned backoff", async () => {
      // r5 (3882010299) — the verified path's own race: pass A's resolver stalls and later
      // returns a NORMAL pending verdict (not an exception) after the record was re-failed and
      // the successor earned its 30s deferral. Scheduling now happens inside the same claim
      // lock as the identity re-read, so A's verdict is recognized as stale THERE and writes
      // nothing: the successor is quiet at 29s and asked exactly past its own due time.
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
});

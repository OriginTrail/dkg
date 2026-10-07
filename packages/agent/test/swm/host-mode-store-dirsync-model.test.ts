/**
 * Seeded model-based test of the SWM host store's directory-fsync tracking.
 *
 * The property under test: an acknowledged write is durable, where "durable"
 * follows the only guarantee a directory fsync gives. It covers the renames
 * (and unlinks) that had RETURNED before it STARTED, and only if it succeeded.
 *
 * The oracle keeps a monotonic durable view. Every directory fsync takes a
 * snapshot of the visible `.meta` / `.log` files the moment it starts; when it
 * succeeds, the snapshot becomes the durable content of every file whose
 * currently recorded snapshot started earlier (so durability never goes back to
 * an older state). Each acknowledgement is then checked against that view:
 *
 *   - markRegistered / markUnregistered / markHostModeSubscribed /
 *     markHostModeUnsubscribed: the durable `.meta` carries the requested flag;
 *   - append: the durable `.meta` cursor is at least the acknowledged seqno;
 *   - prune: no durable `.log` of a CG the prune visited still holds a frame the
 *     prune's cutoff had expired (an absent durable log is fine: it was unlinked,
 *     and that unlink must itself be covered by a directory fsync).
 *
 * The scheduler is seeded. The mocked directory fsync does not return on its
 * own: each call sits in flight until the driver settles it. Its outcome is drawn
 * when it starts; a failing fsync is quick and a succeeding one may linger, so a
 * slow success is often still in flight while another write renames and fails
 * underneath it, and fsyncs overlap and complete out of order. Callers retry a
 * rejected operation, or move on to something else, as the agent does; only a
 * fulfilled call is checked. Two workloads are mixed by seed: CGs that only flip
 * marks (two seeds in three: the interleavings the directory-fsync bookkeeping is
 * about), and CGs that also append past the byte cap and get swept by concurrent
 * prunes.
 *
 * Seeded means the failures and the order in which fsyncs finish are drawn from
 * the seed; how they interleave with the real file I/O underneath is not, so a
 * failing seed is a pointer to the trace it prints, not an exact replay. The
 * deterministic regression tests in host-mode-store-dirsync-retries.test.ts pin the
 * known cases; this test is the net for the ones nobody thought of.
 *
 * The default seed count keeps this in the unit lane's budget. For a wide run:
 *   HOST_STORE_MODEL_SEEDS=2000 npx vitest run --config vitest.unit.config.ts \
 *     test/swm/host-mode-store-dirsync-model.test.ts
 * (HOST_STORE_MODEL_FROM picks the first seed.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp, readdirSync, readFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../src/rfc64/secure-filesystem-policy-v1.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rfc64/secure-filesystem-policy-v1.js')>();
  return { ...actual, fsyncRfc64DirectoryV1: vi.fn(actual.fsyncRfc64DirectoryV1) };
});

import * as fsPolicy from '../../src/rfc64/secure-filesystem-policy-v1.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';

const DEFAULT_SEEDS = 16;
const SEEDS = Number(process.env.HOST_STORE_MODEL_SEEDS ?? DEFAULT_SEEDS);
const FIRST_SEED = Number(process.env.HOST_STORE_MODEL_FROM ?? 1);
const BATCH = 24; // seeds running side by side
const HEADER_BYTES = 20;
const TTL_MS = 1_000;
const BYTE_CAP = 360; // a handful of small frames: appends overflow it and exercise the rewrite prune
const MAX_TRIES = 10;
const P_GIVE_UP = 0.6; // after a rejection: the chance the caller moves on instead of retrying
const MAX_TICKS = 400_000;

type Kind = 'reg' | 'unreg' | 'sub' | 'unsub' | 'append';
interface Profile {
  cgs: string[];
  opsPerCg: number;
  kinds: Kind[];
  prunes: number;
}
const cgNames = (count: number) => Array.from({ length: count }, (_, i) => `cg/model-${i}`);
const MARKS: Profile = { cgs: cgNames(5), opsPerCg: 6, kinds: ['reg', 'unreg', 'sub', 'unsub'], prunes: 0 };
const MIXED: Profile = { cgs: cgNames(3), opsPerCg: 7, kinds: ['reg', 'unreg', 'sub', 'unsub', 'append'], prunes: 3 };
const profileOf = (seed: number): Profile => (seed % 3 === 0 ? MIXED : MARKS);

function cgKey(contextGraphId: string): string {
  return createHash('sha256').update(contextGraphId).digest('base64url');
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Timestamps of the complete frames in a log buffer (an independent parse of the wire format). */
function frameTimestamps(buf: Buffer): number[] {
  const out: number[] = [];
  let offset = 0;
  while (offset + HEADER_BYTES <= buf.length) {
    const end = offset + HEADER_BYTES + buf.readUInt32BE(offset + 16);
    if (end > buf.length) break;
    out.push(Number(buf.readBigUInt64BE(offset)));
    offset = end;
  }
  return out;
}

interface InFlightFsync {
  id: number;
  /** The scheduler tick at which the driver lets this fsync finish. */
  dueTick: number;
  fails: boolean;
  /** The visible content of every `.meta` / `.log` when this fsync STARTED. */
  snapshot: Map<string, Buffer>;
  resolve: () => void;
  reject: (err: Error) => void;
}

describe('SwmHostModeStore directory-fsync tracking: seeded model against a monotonic durable view', () => {
  /** Seeds run side by side, each in its own directory; the mocked fsync hands a call to the run that owns its directory. */
  const fsyncOwners = new Map<string, () => Promise<void>>();

  beforeEach(async () => {
    const probeDir = await mkdtemp(path.join(tmpdir(), 'dkg-host-store-model-probe-'));
    const probePath = path.join(probeDir, 'probe');
    await writeFile(probePath, 'x');
    const probe = await fsp.open(probePath, 'r');
    const fileHandleProto = Object.getPrototypeOf(probe) as FileHandle; // FileHandle is not exported
    await probe.close();
    await rm(probeDir, { recursive: true, force: true });
    // Temp-file and log fsyncs are not what this model is about, and real ones would dominate the runtime.
    vi.spyOn(fileHandleProto, 'sync').mockResolvedValue(undefined);
    vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mockImplementation((dir) => {
      const owner = fsyncOwners.get(dir);
      if (!owner) throw new Error(`directory fsync of ${dir} belongs to no running seed`);
      return owner();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mockReset();
    fsyncOwners.clear();
  });

  /** One seeded run. Returns the violations it found (empty when the store kept its promise). */
  async function runSeed(seed: number): Promise<string[]> {
    const profile = profileOf(seed);
    const rng = mulberry32(seed * 2654435761);
    const dir = await mkdtemp(path.join(tmpdir(), 'dkg-host-store-model-'));
    const violations: string[] = [];
    const trace: string[] = [];
    const note = (line: string) => { trace.push(line); if (trace.length > 80) trace.shift(); };
    const violate = (message: string) => violations.push(`seed ${seed}: ${message}\n  ...${trace.slice(-30).join('\n  ')}`);

    let nowMs = 1_000_000;
    const limits = { perCgByteCap: BYTE_CAP, ttlMs: TTL_MS };
    const store = new SwmHostModeStore({ dataDir: dir, unregisteredLimits: limits, registeredLimits: limits, now: () => nowMs });
    const fileOf = (cg: string, ext: 'meta' | 'log') => path.join(dir, `${cgKey(cg)}.${ext}`);

    // ── the durable view ──
    const durable = new Map<string, Buffer | null>();
    const durableSince = new Map<string, number>();
    const inFlight: InFlightFsync[] = [];
    let fsyncSeq = 0;
    const pFail = 0.3 + rng() * 0.3;
    // How long a succeeding directory fsync may stay in flight, in scheduler ticks: long enough for
    // other writes to run their whole rename-and-fsync cycle underneath it.
    const maxHold = 6 + Math.floor(rng() * 50);
    let tick = 0;

    const snapshot = (): Map<string, Buffer> => {
      const out = new Map<string, Buffer>();
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.meta') && !name.endsWith('.log')) continue;
        try { out.set(path.join(dir, name), readFileSync(path.join(dir, name))); } catch { /* unlinked meanwhile: absent */ }
      }
      return out;
    };
    const durableMeta = (cg: string): { registered?: boolean; hostModeSubscribed?: boolean; seqno?: number } => {
      const buf = durable.get(fileOf(cg, 'meta'));
      return buf ? JSON.parse(buf.toString('utf8')) : {};
    };

    fsyncOwners.set(dir, () => new Promise<void>((resolve, reject) => {
      const fails = rng() < pFail;
      const entry: InFlightFsync = {
        id: (fsyncSeq += 1),
        dueTick: tick + 1 + Math.floor(rng() * (fails ? 3 : maxHold)),
        fails,
        snapshot: snapshot(),
        resolve,
        reject,
      };
      note(`fsync#${entry.id} start`);
      inFlight.push(entry);
    }));
    const settle = (entry: InFlightFsync) => {
      inFlight.splice(inFlight.indexOf(entry), 1);
      if (entry.fails) {
        note(`fsync#${entry.id} FAIL`);
        entry.reject(new Error('injected directory fsync failure'));
        return;
      }
      note(`fsync#${entry.id} ok`);
      // Durability is monotonic in START order: only a later start may replace what an earlier one made durable.
      for (const file of new Set([...entry.snapshot.keys(), ...durable.keys()])) {
        if ((durableSince.get(file) ?? 0) < entry.id) {
          durable.set(file, entry.snapshot.get(file) ?? null);
          durableSince.set(file, entry.id);
        }
      }
      entry.resolve();
    };

    // ── the workload ──
    const isInjected = (err: unknown) => err instanceof Error && err.message === 'injected directory fsync failure';
    // A caller whose write was rejected sometimes retries it and sometimes moves on to something else
    // (a later event, another request). `persistent` callers never move on.
    const retrying = async (label: string, run: () => Promise<void>, persistent = false): Promise<boolean> => {
      for (let attempt = 1; attempt <= (persistent ? 6 * MAX_TRIES : MAX_TRIES); attempt += 1) {
        try {
          await run();
          note(`${label} ACK (attempt ${attempt})`);
          return true;
        } catch (err) {
          if (!isInjected(err)) throw err;
          note(`${label} rejected (attempt ${attempt})`);
          if (!persistent && rng() < P_GIVE_UP) return false;
        }
      }
      return false;
    };

    const appendChecked = async (cg: string, label: string, n: number): Promise<void> => {
      const seqno = await store.append(cg, new Uint8Array([n, seed & 0xff]));
      if ((durableMeta(cg).seqno ?? 0) < seqno) violate(`${label} acknowledged seqno ${seqno} but the durable cursor is ${durableMeta(cg).seqno}`);
    };

    const client = async (cg: string): Promise<void> => {
      for (let i = 0; i < profile.opsPerCg; i += 1) {
        const kind = profile.kinds[Math.floor(rng() * profile.kinds.length)];
        const label = `${cg.slice(-1)}:${kind}`;
        await retrying(label, async () => {
          switch (kind) {
            case 'reg':
              await store.markRegistered(cg);
              if (durableMeta(cg).registered !== true) violate(`${label} acknowledged but the durable meta says registered=${durableMeta(cg).registered}`);
              return;
            case 'unreg':
              await store.markUnregistered(cg);
              if (durableMeta(cg).registered === true) violate(`${label} acknowledged but the durable meta still says registered=true`);
              return;
            case 'sub':
              await store.markHostModeSubscribed(cg);
              if (durableMeta(cg).hostModeSubscribed !== true) violate(`${label} acknowledged but the durable meta says hostModeSubscribed=${durableMeta(cg).hostModeSubscribed}`);
              return;
            case 'unsub':
              await store.markHostModeUnsubscribed(cg);
              if (durableMeta(cg).hostModeSubscribed === true) violate(`${label} acknowledged but the durable meta still says hostModeSubscribed=true`);
              return;
            case 'append':
              await appendChecked(cg, label, i);
              return;
          }
        });
        await Promise.resolve();
      }
    };

    const pruner = async (): Promise<void> => {
      for (let round = 0; round < profile.prunes; round += 1) {
        // Only this loop moves the clock, so a prune never sees it change underneath it.
        // Half of the rounds keep one fresh frame in every CG, so the prune rewrites (renames) its log; in the
        // others the clock jumps past every frame's TTL, so the prune removes (unlinks) the logs it finds.
        const keepFresh = rng() < 0.5;
        nowMs += keepFresh ? Math.floor(rng() * TTL_MS * 1.5) : Math.floor(TTL_MS * (1.1 + rng()));
        const cutoff = nowMs - TTL_MS;
        if (keepFresh) {
          const fresh = await Promise.all(profile.cgs.map((cg) => retrying(`${cg.slice(-1)}:fresh-append`, () => appendChecked(cg, `${cg.slice(-1)}:fresh-append`, round), true)));
          if (fresh.includes(false)) continue;
        }
        const visited = profile.cgs.filter((cg) => snapshot().has(fileOf(cg, 'meta')));
        await retrying('prune', async () => {
          await store.prune();
          for (const cg of visited) {
            const buf = durable.get(fileOf(cg, 'log'));
            if (!buf) continue; // never durable, or unlinked: no expired ciphertext survives
            const expired = frameTimestamps(buf).filter((ts) => ts < cutoff);
            if (expired.length > 0) violate(`prune acknowledged but the durable log of ${cg} still holds ${expired.length} frame(s) older than the cutoff ${cutoff}`);
          }
        });
      }
    };

    await store.init();
    const workers = Promise.all([...profile.cgs.map((cg) => client(cg)), ...(profile.prunes > 0 ? [pruner()] : [])]);
    let finished = false;
    workers.then(() => { finished = true; }, () => { finished = true; });
    try {
      for (; !finished; tick += 1) {
        if (tick > MAX_TICKS) throw new Error(`seed ${seed}: the run did not finish (a directory fsync was never settled?)\n  ${trace.slice(-20).join('\n  ')}`);
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        for (const entry of inFlight.filter((candidate) => candidate.dueTick <= tick)) settle(entry);
      }
      await workers;
    } finally {
      fsyncOwners.delete(dir);
      await rm(dir, { recursive: true, force: true });
    }
    return violations;
  }

  it(`keeps every acknowledgement durable (${SEEDS} seeds from ${FIRST_SEED})`, async () => {
    const violations: string[] = [];
    const failingSeeds = new Set<number>();
    for (let batch = FIRST_SEED; batch < FIRST_SEED + SEEDS; batch += BATCH) {
      const seeds = Array.from({ length: Math.min(BATCH, FIRST_SEED + SEEDS - batch) }, (_, i) => batch + i);
      const results = await Promise.all(seeds.map((seed) => runSeed(seed)));
      results.forEach((found, i) => {
        if (found.length > 0) failingSeeds.add(seeds[i]);
        violations.push(...found);
      });
    }
    expect(violations.slice(0, 3), `${violations.length} violation(s) in seeds ${[...failingSeeds].join(', ')}`).toEqual([]);
  }, 900_000);
});

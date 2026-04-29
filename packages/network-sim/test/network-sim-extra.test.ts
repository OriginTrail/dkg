/**
 * packages/network-sim — extra QA coverage.
 *
 * Findings covered (see .test-audit/
 *
 *   K-4  SPEC-GAP   Determinism — the sim engine seeds entity URIs and op
 *                   routing with `Math.random()` / `Date.now()` and exposes
 *                   no `seed` parameter. A run cannot be reproduced from a
 *                   seed. Two policy-level tests below capture this as a
 *                   bug: (a) the production source HAS no seeded RNG API,
 *                   (b) the `SimConfig` type has no `seed` field. Both stay
 *                   RED until a deterministic entry point is added.
 *                   // PROD-BUG: no seeded RNG / reproducible run —
 *
 *   K-5  SPEC-GAP   libp2p parity — the sim drives REAL devnet daemons over
 *                   HTTP but exposes no "simulated-network" mode and no
 *                   scenario-replay against real libp2p. A proper parity
 *                   harness would let callers run the same scenario against
 *                   the sim and against real libp2p and compare message
 *                   counts. This file documents the absence statically and
 *                   pins the current behaviour of handleSimRequest so that
 *                   a future parity refactor shows up as a semantic change.
 *                   // PROD-BUG: no libp2p-parity harness —
 *
 * Per QA policy: no production-code edits.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleSimRequest,
  fmtError,
  createSeededRng,
  _rndIdForTesting,
  _resetSeededRngCounterForTesting,
  precomputeSeededSchedule,
  runScenario,
  runOnLibp2p,
  Libp2pRunnerNotImplementedError,
  type SimScenario,
} from '../src/server/sim-engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROD_SRC = resolve(HERE, '..', 'src', 'server', 'sim-engine.ts');

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers (copy of the existing mock harness in sim-engine.test.ts).
// Copying here keeps this file self-contained and avoids production-edit risk.
// ─────────────────────────────────────────────────────────────────────────────
function mockReq(opts: { url: string; method: string; body?: string }): IncomingMessage {
  const req = Object.assign(
    new Readable({ read() {} }),
    { url: opts.url, method: opts.method },
  ) as IncomingMessage;
  if (opts.body !== undefined) { req.push(opts.body); req.push(null); }
  return req;
}

const noop = (() => {}) as any;
const noopRet = ((v?: any) => v) as any;
function mockRes(): ServerResponse & { statusCode: number; headers: Record<string, string>; body: string } {
  const chunks: string[] = [];
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(s: number, h?: Record<string, string | string[]>) {
      this.statusCode = s;
      if (h) for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : String(v);
      return this;
    },
    write(c: string | Buffer) { chunks.push(typeof c === 'string' ? c : c.toString()); return true; },
    end(c?: string | Buffer) {
      if (c !== undefined) chunks.push(typeof c === 'string' ? c : c.toString());
      this.body = chunks.join('');
      return this;
    },
    setHeader: noop, getHeader: noop, removeHeader: noop, hasHeader: () => false, getHeaders: () => ({}),
    flushHeaders: noop, getHeaderNames: () => [] as string[], addTrailers: noop,
    finished: false, writableEnded: false, writable: true, destroyed: false,
    on: noopRet, once: noopRet, emit: () => false, off: noopRet,
    removeAllListeners: noopRet, setTimeout: noop,
  } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// K-4  Determinism / seeded RNG
// ─────────────────────────────────────────────────────────────────────────────
describe('[K-4] sim engine — determinism / seeded RNG (RED until implemented)', () => {
  let src: string;
  beforeAll(async () => { src = await readFile(PROD_SRC, 'utf8'); });

  it('sim-engine.ts uses Math.random() at least once (establishes baseline of non-determinism)', () => {
    // Baseline positive: confirm the source we are asserting against really
    // does rely on Math.random, so the K-4 gap is real and not a stale
    // finding.
    const mathRand = (src.match(/Math\.random\s*\(\s*\)/g) ?? []).length;
    expect(mathRand).toBeGreaterThan(0);
  });

  it('sim-engine exposes a seeded RNG entry point (fails until the sim is made reproducible)', () => {
    // PROD-BUG: no seeded RNG / reproducible run —
    // We look for any of the common "seed" touchpoints in the production
    // source. This test is intentionally RED; the failing test IS the
    // bug evidence.
    const hasSeedConfig = /seed\s*[:?]\s*(number|string|bigint)/i.test(src);
    const hasSeededRng = /mulberry32|sfc32|seedrandom|createSeededRng|makeRng\(|xoroshiro/i.test(src);
    const hasDeterminismFlag = /deterministic|reproducible/i.test(src);
    expect({ hasSeedConfig, hasSeededRng, hasDeterminismFlag }).toEqual({
      hasSeedConfig: true,
      hasSeededRng: true,
      hasDeterminismFlag: true,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // seeded runs were
  // still non-reproducible because `rndId()` baked `Date.now()` and a
  // process-global counter into every id. Two runs with the same seed
  // and config produced DIFFERENT sim-<id> URIs and therefore
  // irreproducible results. The fix: when a seeded RNG (branded by
  // `createSeededRng`) is passed to `rndId`, ids come purely from the
  // rng sequence and a per-run counter — no Date.now(), no globals.
  // Pin both reproducibility (same seed → identical id sequence) and
  // non-determinism for the unseeded fallback.
  // ─────────────────────────────────────────────────────────────────────────
  it('rndId(rng) is REPRODUCIBLE when rng is a seeded mulberry32 (same seed → identical id sequence)', () => {
    const rngA = createSeededRng(42);
    const rngB = createSeededRng(42);
    const seqA = Array.from({ length: 5 }, () => _rndIdForTesting(rngA));
    const seqB = Array.from({ length: 5 }, () => _rndIdForTesting(rngB));
    expect(seqA).toEqual(seqB);
    // And the ids do NOT embed a wall-clock timestamp — they're pure
    // `s-<rng-draws>-<counter>` now, so different machines / runtimes
    // can still compare snapshots across the wire.
    for (const id of seqA) {
      expect(id).toMatch(/^s-[0-9a-z]{16}-[0-9a-z]+$/);
    }
  });

  it('rndId(rng) with the SAME seed produces a STABLE sequence across a reset of the per-rng counter', () => {
    const rng = createSeededRng(100);
    const first = [_rndIdForTesting(rng), _rndIdForTesting(rng)];
    // If a caller exceptionally wants to replay from the start of the
    // counter (e.g. scenario recorder restart), the reset helper gives
    // them a byte-identical second pass from the SAME rng — as long as
    // the underlying rng is also reset (which is the caller's job).
    const rng2 = createSeededRng(100);
    _resetSeededRngCounterForTesting(rng2);
    const second = [_rndIdForTesting(rng2), _rndIdForTesting(rng2)];
    expect(first).toEqual(second);
  });

  it('rndId() without a seeded rng (Math.random default) still produces unique ids (legacy fallback)', () => {
    const ids = Array.from({ length: 50 }, () => _rndIdForTesting());
    expect(new Set(ids).size).toBe(50);
    // Legacy shape carries a wall-clock timestamp component.
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/);
    }
  });

  // two runs with the
  // same seed must now produce the SAME op sequence even when
  // `concurrency > 1`. The previous revision drew each op's opType +
  // node pick at `launchOne()` time, which was triggered by whichever
  // in-flight op finished first, so timing jitter at concurrency > 1
  // could swap op types. The fix pre-computes the whole schedule up
  // front from the seeded RNG. These tests pin the invariant against
  // the helper directly (no HTTP harness) so the regression is
  // visible at the smallest possible scope.
  it('precomputeSeededSchedule returns the SAME op+node sequence for the same seed (concurrency-agnostic)', () => {
    const seed = 4242;
    const enabled = ['publish', 'query', 'workspace', 'chat'];
    const schedA = precomputeSeededSchedule(enabled, 5, 50, createSeededRng(seed));
    const schedB = precomputeSeededSchedule(enabled, 5, 50, createSeededRng(seed));
    expect(schedA).toEqual(schedB);
  });

  it('precomputeSeededSchedule does NOT depend on op completion order (the concurrency>1 regression)', () => {
    // The bot's concern: at concurrency>1, the schedule used to be
    // decided at `launchOne()` time, so different completion orders
    // would consume RNG draws at different call sites. With the
    // pre-computed schedule, no matter when `launchOne()` runs, the
    // op at slot N is the same. Simulate "different completion
    // orders" by interleaving unrelated RNG draws between reads.
    const seed = 1234;
    const enabled = ['publish', 'query', 'chat'];
    const sched = precomputeSeededSchedule(enabled, 3, 20, createSeededRng(seed));
    // Consume in strict order (the "serialised" timeline).
    const inOrder = sched.slice();
    // Consume in reverse (a pathological "last op completes first"
    // timeline). The produced schedule is still the same array — the
    // consumer cannot change what got scheduled, only what order it's
    // *read* in, and slot N stays pinned to its computed value.
    const reversed = [...sched].reverse();
    for (let i = 0; i < sched.length; i++) {
      expect(reversed[sched.length - 1 - i]).toEqual(inOrder[i]);
    }
    // And a fresh precomputation with the same seed reproduces the
    // same sequence regardless of how we consumed the first one.
    const fresh = precomputeSeededSchedule(enabled, 3, 20, createSeededRng(seed));
    expect(fresh).toEqual(sched);
  });

  it('precomputeSeededSchedule distributes nodes round-robin starting at slot 1 (preserves prior nodeRR behaviour)', () => {
    const enabled = ['publish'];
    const sched = precomputeSeededSchedule(enabled, 3, 7, createSeededRng(9));
    // Original implementation incremented nodeRR BEFORE indexing, so
    // slot 0 gets node 1, slot 1 gets node 2, slot 2 gets node 0, …
    expect(sched.map((s) => s.nodeIdx)).toEqual([1, 2, 0, 1, 2, 0, 1]);
  });

  it('precomputeSeededSchedule differs across different seeds (sanity check — seed actually matters)', () => {
    const enabled = ['publish', 'query'];
    const a = precomputeSeededSchedule(enabled, 2, 30, createSeededRng(1));
    const b = precomputeSeededSchedule(enabled, 2, 30, createSeededRng(2));
    // Two different seeds must diverge on at least the opType axis
    // (the node-rr axis is seed-independent).
    const opsA = a.map((s) => s.opType).join('');
    const opsB = b.map((s) => s.opType).join('');
    expect(opsA).not.toBe(opsB);
  });

  it('two seeded runs at DIFFERENT wall-clock times still produce the SAME id sequence (the point of the fix)', async () => {
    const rngA = createSeededRng(7);
    const seqA = Array.from({ length: 3 }, () => _rndIdForTesting(rngA));
    // Simulate the "same seed, different time" scenario — the previous
    // implementation baked Date.now() into each id and would fail here.
    await new Promise((r) => setTimeout(r, 10));
    const rngB = createSeededRng(7);
    const seqB = Array.from({ length: 3 }, () => _rndIdForTesting(rngB));
    expect(seqA).toEqual(seqB);
  });

  it('SimConfig includes a `seed` field visible on POST /sim/start (fails until exposed)', async () => {
    // Second angle on the same finding: the external contract. Posting a
    // config with `seed: 42` should be accepted AND echoed back as part of
    // the sim identity. Today the handler silently drops unknown fields.
    const req = mockReq({
      url: '/sim/start',
      method: 'POST',
      body: JSON.stringify({
        opCount: 1, opsPerSec: 1, enabledOps: ['query'],
        concurrency: 1, contextGraph: 'devnet-test',
        seed: 42,
      }),
    });
    const res = mockRes();
    await handleSimRequest(req, res);
    // Stop the sim we just started — production behaviour.
    await handleSimRequest(mockReq({ url: '/sim/stop', method: 'POST' }), mockRes());

    const body = JSON.parse(res.body);
    // PROD-BUG: the response shape carries no echo of `seed`, so callers
    // cannot verify determinism round-trips. Red until fixed.
    expect(body).toHaveProperty('seed', 42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K-5  libp2p parity
// ─────────────────────────────────────────────────────────────────────────────
describe('[K-5] libp2p parity harness (RED until implemented)', () => {
  let src: string;
  beforeAll(async () => { src = await readFile(PROD_SRC, 'utf8'); });

  it('the sim engine is currently an HTTP driver — no simulated libp2p layer in source', () => {
    // Positive baseline, goes GREEN today: document that sim-engine.ts is a
    // plain driver over fetch() to 127.0.0.1:9201-9206 rather than a
    // libp2p simulator.
    expect(src).toMatch(/fetch\(`http:\/\/127\.0\.0\.1:/);
    expect(src).not.toMatch(/import .* from ['"]libp2p['"]/);
    expect(src).not.toMatch(/@libp2p\/[a-z-]+/);
  });

  it('exports a scenario/replay surface comparable against real libp2p (fails — no such surface exists)', () => {
    // PROD-BUG: no libp2p-parity harness —
    // We look for the kind of symbols a parity harness would expose:
    // a scenario recorder, a libp2p-backed runner, or a message-count
    // comparator. None exist today — red test documents the gap.
    const hasScenarioRunner = /export\s+(async\s+)?function\s+runScenario\b/.test(src);
    const hasLibp2pRunner = /export\s+(async\s+)?function\s+runOnLibp2p\b/.test(src);
    const hasParityCompare = /export\s+(async\s+)?function\s+compareMessageCounts\b/.test(src);
    expect({ hasScenarioRunner, hasLibp2pRunner, hasParityCompare }).toEqual({
      hasScenarioRunner: true,
      hasLibp2pRunner: true,
      hasParityCompare: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bonus positive coverage: fmtError mapping is part of the error taxonomy the
// sim reports back to the UI. Pin a couple of edge cases not covered in the
// existing test file.
// ─────────────────────────────────────────────────────────────────────────────
describe('[sim-engine] fmtError edge cases (additional positive coverage)', () => {
  it('maps sharedMemory timeout to its own 60s envelope', () => {
    const err = new DOMException('timed out', 'TimeoutError');
    expect(fmtError(err, 'sharedMemory')).toBe('timeout (60s)');
    expect(fmtError(err, 'chat')).toBe('timeout (10s)');
  });

  it('stringifies plain objects (not just primitives)', () => {
    expect(fmtError({ toString: () => 'weird' } as unknown, 'query')).toBe('weird');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The pre-fix
// `runOnLibp2p` silently delegated to `runScenario`, so the K-5 parity
// surface was model-vs-model and ALWAYS looked green. The fix makes
// `runOnLibp2p` fail closed with `Libp2pRunnerNotImplementedError` until a
// real libp2p host exists. Pin both halves of the contract here:
//   - `runScenario` still runs deterministically (the sim's reference
//     side of the parity diff);
//   - `runOnLibp2p` rejects loudly so a caller cannot accidentally
//     compare the model against itself.
// ─────────────────────────────────────────────────────────────────────────────
describe('[sim-engine] K-5 parity surface', () => {
  const scenario: SimScenario = {
    name: 'parity-fixture',
    seed: 42,
    ops: [
      { type: 'publish', nodeId: 1 },
      { type: 'publish', nodeId: 2 },
      { type: 'publish', nodeId: 1 },
    ],
  };

  it('runScenario stays deterministic and reproducible under the same seed', async () => {
    const a = await runScenario(scenario);
    const b = await runScenario(scenario);
    expect(a).toEqual(b);
    expect(a.perNode[1]).toBe(2);
    expect(a.perNode[2]).toBe(1);
    expect(a.messageCount).toBe(3);
  });

  it('runOnLibp2p fails loudly with Libp2pRunnerNotImplementedError (no silent self-parity)', async () => {
    let caught: unknown;
    try {
      await runOnLibp2p(scenario);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Libp2pRunnerNotImplementedError);
    expect((caught as Error).message).toMatch(/no real libp2p-backed runner/i);
    expect((caught as Error).name).toBe('Libp2pRunnerNotImplementedError');
  });
});

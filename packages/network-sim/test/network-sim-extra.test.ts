/**
 * packages/network-sim — extra QA coverage.
 *
 * Findings covered (see .test-audit/BUGS_FOUND.md):
 *
 *   K-4  SPEC-GAP   Determinism — the sim engine seeds entity URIs and op
 *                   routing with `Math.random()` / `Date.now()` and exposes
 *                   no `seed` parameter. A run cannot be reproduced from a
 *                   seed. Two policy-level tests below capture this as a
 *                   bug: (a) the production source HAS no seeded RNG API,
 *                   (b) the `SimConfig` type has no `seed` field. Both stay
 *                   RED until a deterministic entry point is added.
 *                   // PROD-BUG: no seeded RNG / reproducible run — see BUGS_FOUND.md K-4
 *
 *   K-5  SPEC-GAP   libp2p parity — the sim drives REAL devnet daemons over
 *                   HTTP but exposes no "simulated-network" mode and no
 *                   scenario-replay against real libp2p. A proper parity
 *                   harness would let callers run the same scenario against
 *                   the sim and against real libp2p and compare message
 *                   counts. This file documents the absence statically and
 *                   pins the current behaviour of handleSimRequest so that
 *                   a future parity refactor shows up as a semantic change.
 *                   // PROD-BUG: no libp2p-parity harness — see BUGS_FOUND.md K-5
 *
 * Per QA policy: no production-code edits.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSimRequest, fmtError } from '../src/server/sim-engine.js';

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
    // PROD-BUG: no seeded RNG / reproducible run — see BUGS_FOUND.md K-4.
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
    // PROD-BUG: no libp2p-parity harness — see BUGS_FOUND.md K-5.
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

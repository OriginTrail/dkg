/**
 * Unit tests for daemon HTTP-utils security helpers.
 *
 * Both helpers under test were flagged on PR #229 review:
 *
 *   - r3146360283 / `isValidContextGraphId` —
 *       The original CLI-16 fix used a blanket `id.includes('..')` to
 *       reject path traversal. That over-rejected valid URI/DID-shaped
 *       context-graph IDs (e.g. `https://example.com/a..b`,
 *       `urn:cg:v1..2`) which never resolve to a parent-directory
 *       segment.  The segment-aware check below is the only check the
 *       OS / URL resolver actually treats as a traversal vector.
 *
 *   - r3146360288 / `sanitizeRevertMessage` —
 *       The original sanitiser only redacted `data="0x…"`. Providers
 *       (ethers, viem, hardhat) also serialise revert blobs as
 *       `data=0x…`, `errorData="0x…"`, `errorData=0x…`, and JSON
 *       `"data":"0x…"`. Any of those slipping through the sanitiser
 *       leaks a custom-error selector to operators (PR #229 CLI-9
 *       leak class).
 *
 * These tests pin the contract at the HELPER level so we don't depend
 * on a full daemon spin-up to detect a regression. The integration-level
 * sibling assertions live in `daemon-http-behavior-extra.test.ts`
 * (CLI-9, CLI-16 blocks) and continue to exercise the wired-up daemon.
 */
import { describe, it, expect } from 'vitest';
import { ServerResponse } from 'node:http';
import { isValidContextGraphId, sanitizeRevertMessage, jsonResponse } from '../src/daemon.js';

describe('isValidContextGraphId — segment-aware path-traversal rejection', () => {
  // Real traversal patterns: every segment that EQUALS `.` or `..`
  // must still be rejected. These are what the OS / URL resolver
  // collapses into a parent-dir reference.
  for (const bad of [
    '..',
    '.',
    '../etc/passwd',
    '../../root',
    './../_private',
    'legit-cg/../../other-cg',
    'a/./b',
    'a/../b',
    '/..',
    '../',
    'cg/.',
    'cg/..',
    './cg',
  ]) {
    it(`rejects "${bad}" as a traversal segment`, () => {
      expect(isValidContextGraphId(bad)).toBe(false);
    });
  }

  // Bot review r3146360283: these URI / DID shaped IDs contain `..`
  // INSIDE a single segment but never resolve to a parent dir. The
  // pre-fix sanitiser broke them. They must validate as legitimate
  // context-graph IDs.
  for (const good of [
    'urn:cg:v1..2',
    'urn:dkg:context-graph:semver..rc',
    'did:dkg:context-graph:project..staging',
    'cg-with..dots-in-segment',
    'a..b',
    'company..product',
  ]) {
    it(`accepts URI/DID-shaped id "${good}" (\`..\` inside single segment)`, () => {
      expect(isValidContextGraphId(good)).toBe(true);
    });
  }

  // Length / charset rules still hold.
  it('rejects empty string', () => {
    expect(isValidContextGraphId('')).toBe(false);
  });
  it('rejects > 256 chars', () => {
    expect(isValidContextGraphId('a'.repeat(257))).toBe(false);
  });
  it('rejects characters outside the whitelist', () => {
    expect(isValidContextGraphId('cg with space')).toBe(false);
    expect(isValidContextGraphId('cg<script>')).toBe(false);
    expect(isValidContextGraphId('cg;DROP TABLE')).toBe(false);
  });
  it('accepts standard slug, URN, DID, https forms', () => {
    expect(isValidContextGraphId('my-context-graph')).toBe(true);
    expect(isValidContextGraphId('urn:dkg:cg:my-cg')).toBe(true);
    expect(isValidContextGraphId('did:dkg:cg:my-cg')).toBe(true);
    expect(isValidContextGraphId('https://example.com/cg')).toBe(true);
    expect(isValidContextGraphId('cg-1.0.0')).toBe(true);
  });
});

describe('sanitizeRevertMessage — redacts every revert-blob shape recognised by enrichEvmError', () => {
  // Pre-fix only this variant got redacted.
  it('redacts `data="0x…"` (quoted, `=`)', () => {
    const out = sanitizeRevertMessage('error: data="0xdeadbeef" (call failed)');
    expect(out).toContain('data="<redacted>"');
    expect(out).not.toContain('0xdeadbeef');
  });

  // PR #229 r3146360288 — these ALL leaked pre-fix.
  it('redacts `data=0x…` (unquoted, `=`)', () => {
    const out = sanitizeRevertMessage('CALL_EXCEPTION: data=0xabcdef0123');
    expect(out).toContain('data=<redacted>');
    expect(out).not.toContain('0xabcdef0123');
  });
  it('redacts `errorData="0x…"` (quoted, `=`)', () => {
    const out = sanitizeRevertMessage('reverted (errorData="0xcafebabe", code=4)');
    expect(out).toContain('errorData="<redacted>"');
    expect(out).not.toContain('0xcafebabe');
  });
  it('redacts `errorData=0x…` (unquoted, `=`)', () => {
    const out = sanitizeRevertMessage('reverted errorData=0xfeedface');
    expect(out).toContain('errorData=<redacted>');
    expect(out).not.toContain('0xfeedface');
  });
  it('redacts JSON `"data":"0x…"`', () => {
    const out = sanitizeRevertMessage(
      'rpc body: {"code":3,"message":"execution reverted","data":"0x12345678abcdef"}',
    );
    expect(out).toContain('"data":"<redacted>"');
    expect(out).not.toContain('0x12345678abcdef');
  });
  it('redacts the `unknown custom error` marker', () => {
    const out = sanitizeRevertMessage(
      'execution reverted: unknown custom error 0xab12cd34. Please retry.',
    );
    expect(out).toContain('request rejected by chain');
    // The marker text is gone.
    expect(out).not.toMatch(/unknown custom error/i);
  });
  it('redacts MULTIPLE blobs in the same message', () => {
    const out = sanitizeRevertMessage(
      'execution reverted: data="0xaaaa" wrapped; errorData=0xbbbb; rpc body {"data":"0xcccc"}',
    );
    expect(out).not.toMatch(/0xaaaa|0xbbbb|0xcccc/);
    expect(out).toContain('<redacted>');
  });
  it('leaves a non-revert message untouched (modulo whitespace squashing)', () => {
    const msg = 'config validation failed: missing rpcUrl in chain section';
    expect(sanitizeRevertMessage(msg)).toBe(msg);
  });

  // Defence-in-depth: the helper must NOT introduce its own ReDoS.
  // Pathological input (millions of hex chars) should sanitize in a
  // bounded time, not lock the event loop.
  it('runs in linear time on a pathological 10kB hex blob', () => {
    const huge = '0x' + 'a'.repeat(10_000);
    const msg = `data="${huge}" wrapped`;
    const t0 = Date.now();
    const out = sanitizeRevertMessage(msg);
    const dt = Date.now() - t0;
    expect(out).toContain('data="<redacted>"');
    expect(dt).toBeLessThan(100);
  });
});

/**
 * PR #229 CodeQL js/stack-trace-exposure (http-utils.ts:206) —
 * `jsonResponse` is the single egress point for every JSON HTTP body the
 * daemon writes. Forty-plus call sites pass `{ error: err.message }`
 * straight to it, and Node.js / ethers / libp2p errors regularly embed
 * absolute filesystem paths and v8 stack frames inside `err.message`. A
 * regression at any one of those callers would leak server-internal paths
 * to the wire; the contract tested here is that the egress sink physically
 * scrubs that information before serialising it, so the leak class is
 * defended at the boundary regardless of how individual handlers compose
 * their error bodies.
 */
function captureJsonResponse(status: number, data: unknown): { status: number; body: any } {
  let writtenStatus = -1;
  let writtenBody = '';
  const fakeRes = {
    writeHead(s: number) {
      writtenStatus = s;
    },
    end(body: string) {
      writtenBody = body;
    },
  } as unknown as ServerResponse;
  jsonResponse(fakeRes, status, data);
  return { status: writtenStatus, body: JSON.parse(writtenBody) };
}

describe('jsonResponse — stack-trace / path scrubbing on egress', () => {
  it('strips multi-line v8 stack frames from { error } responses', () => {
    const errMsg =
      'TypeError: foo is undefined\n' +
      '    at handler (/Users/runner/work/dkg/packages/cli/src/daemon/routes/foo.ts:123:45)\n' +
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)';
    const { body } = captureJsonResponse(500, { error: errMsg });
    expect(body.error).toBe('TypeError: foo is undefined');
    expect(body.error).not.toMatch(/at handler/);
    expect(body.error).not.toMatch(/\/Users\//);
  });

  it('redacts inline absolute POSIX paths with line:col in error messages', () => {
    const errMsg = 'cannot find module (/Users/runner/work/dkg/packages/foo/index.js:12:34)';
    const { body } = captureJsonResponse(500, { error: errMsg });
    expect(body.error).toContain('<redacted-path>');
    expect(body.error).not.toMatch(/\/Users\//);
  });

  it('also scrubs the same patterns from `message` / `detail` / `details` fields', () => {
    const errMsg = 'boom\n    at /tmp/secrets/loader.ts:1:1';
    const { body } = captureJsonResponse(500, {
      error: errMsg,
      message: errMsg,
      detail: errMsg,
      details: errMsg,
    });
    for (const k of ['error', 'message', 'detail', 'details'] as const) {
      expect(body[k]).toBe('boom');
    }
  });

  it('leaves a clean error string untouched (no false-positive scrubbing)', () => {
    const msg = 'paranet not found';
    const { body } = captureJsonResponse(404, { error: msg });
    expect(body.error).toBe(msg);
  });

  it('does NOT scrub non-error fields that legitimately contain `/`', () => {
    // Successful responses commonly include URN/URL/path-shaped IDs in
    // result fields; the scrubber must not touch those.
    const ok = {
      ok: true,
      contextGraphId: 'urn:cg:my-project',
      uri: 'http://example.org/resource/42',
      filePath: '/var/lib/dkg/data.ttl', // legitimate, NOT an error
    };
    const { body } = captureJsonResponse(200, ok);
    expect(body).toEqual(ok);
  });

  it('handles nested arrays/objects without mangling them', () => {
    const payload = {
      results: [
        { id: 'a', error: 'oops\n    at /opt/app/x.js:1:2' },
        { id: 'b', value: 7 },
      ],
    };
    const { body } = captureJsonResponse(200, payload);
    expect(body.results[0].error).toBe('oops');
    expect(body.results[1]).toEqual({ id: 'b', value: 7 });
  });

  it('preserves bigint serialisation (regression — original BigInt-as-string contract)', () => {
    const { body } = captureJsonResponse(200, { count: 42n });
    expect(body.count).toBe('42');
  });

  // PR #229 CodeQL js/redos (alerts 56 + 57): the path-redaction regex
  // used `(?:[^\\s()]+\\/)+[^\\s()]+`, where the inner class included
  // the `/` separator. That made the match ambiguous and produced
  // catastrophic backtracking on adversarial inputs starting with `/`
  // and many repetitions of `!/`. Pinning a wall-clock budget here
  // proves the fix: each input below would have taken seconds to fail
  // on the pre-fix regex; with the separator excluded from the
  // segment class, every input matches or rejects in microseconds.
  describe('ReDoS resistance (alerts 56 / 57)', () => {
    it('handles adversarial POSIX-style "/!/" repetitions in microseconds', () => {
      // 200 × "!/" ⇒ before the fix this took ~exponential time and
      // would dominate the test run. With the deterministic regex
      // we expect well under 100ms even on cold CI hardware.
      const adversarial = '/' + '!/'.repeat(200) + 'final';
      const start = Date.now();
      const { body } = captureJsonResponse(500, { error: adversarial });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
      expect(typeof body.error).toBe('string');
    });

    it('handles adversarial Windows-style "A:/!/" repetitions in microseconds', () => {
      const adversarial = 'A:/' + '!/'.repeat(200) + 'final';
      const start = Date.now();
      const { body } = captureJsonResponse(500, { error: adversarial });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
      expect(typeof body.error).toBe('string');
    });

    it('still redacts a real POSIX path next to a "/!/" decoy', () => {
      const msg =
        'cannot load (/Users/runner/work/dkg/packages/foo/index.js:12:34) ' +
        'after seeing "/!/!/!/!" in input';
      const { body } = captureJsonResponse(500, { error: msg });
      expect(body.error).toContain('<redacted-path>');
      expect(body.error).not.toMatch(/\/Users\//);
    });

    it('still redacts a real Windows path next to a "A:/!/" decoy', () => {
      const msg = 'failed at (C:\\Users\\runner\\work\\dkg\\foo.js:12:34) — A:/!/!/';
      const { body } = captureJsonResponse(500, { error: msg });
      expect(body.error).toContain('<redacted-path>');
      expect(body.error).not.toMatch(/C:\\\\?Users/);
    });
  });

  // PR #229 CodeQL js/stack-trace-exposure (alert 47): the egress
  // barrier in `jsonResponse` does a final-mile `String.replace` on the
  // serialised JSON body to strip any `\n   at <fn> (...)` continuation
  // lines that escaped the structural scrub above (e.g. because they
  // were embedded in a non-error-shaped field deep inside a nested
  // payload). The structural scrub is the primary line of defence; the
  // egress barrier is the belt-and-braces fail-safe that CodeQL's
  // taint-flow analysis can statically recognise as a sanitiser.
  describe('egress sink barrier (alert 47, defense-in-depth)', () => {
    it('strips a stack-frame continuation hidden inside a non-error-shaped nested field', () => {
      // `payload.trace` is NOT in ERROR_SHAPED_KEYS, so the structural
      // scrub does NOT touch it. The egress regex MUST still strip the
      // stack-frame continuation to honour the security contract.
      const errMsg = 'oops\n    at handler (/Users/runner/work/foo.ts:1:2)';
      const { body } = captureJsonResponse(500, {
        ok: false,
        payload: { trace: errMsg },
      });
      expect(body.payload.trace).not.toMatch(/at handler/);
      // The leading "oops" survives — only the v8 frame continuation
      // is stripped, not the human-readable error label.
      expect(body.payload.trace).toContain('oops');
    });

    it('is a no-op on already-scrubbed payloads', () => {
      const { body } = captureJsonResponse(200, {
        ok: true,
        msg: 'all systems nominal',
      });
      expect(body).toEqual({ ok: true, msg: 'all systems nominal' });
    });
  });
});

/**
 * Unit tests for daemon HTTP-utils security helpers.
 *
 *   - `isValidContextGraphId` —
 *       The earlier CLI-16 fix used a blanket `id.includes('..')`
 *       to reject path traversal. That over-rejected valid
 *       URI/DID-shaped context-graph IDs (e.g.
 *       `https://example.com/a..b`, `urn:cg:v1..2`) which never
 *       resolve to a parent-directory segment. The segment-aware
 *       check below is the only check the OS / URL resolver
 *       actually treats as a traversal vector.
 *
 *   - `sanitizeRevertMessage` —
 *       The earlier sanitiser only redacted `data="0x…"`. Providers
 *       (ethers, viem, hardhat) also serialise revert blobs as
 *       `data=0x…`, `errorData="0x…"`, `errorData=0x…`, and JSON
 *       `"data":"0x…"`. Any of those slipping through the
 *       sanitiser leaks a custom-error selector to operators
 *       (CLI-9 leak class).
 *
 * These tests pin the contract at the HELPER level so we don't
 * depend on a full daemon spin-up to detect a regression. The
 * integration-level sibling assertions live in
 * `daemon-http-behavior-extra.test.ts` (CLI-9, CLI-16 blocks) and
 * continue to exercise the wired-up daemon.
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

  // these URI / DID shaped IDs contain `..`
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

  // these ALL leaked pre-fix.
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

  // the path-redaction regex
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

  // the egress
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

    // The
    // CodeQL js/stack-trace-exposure alert remained against
    // `res.end(body)` because the prior egress regex only matched the
    // JSON-escaped continuation form `\n   at <fn>`. CodeQL's taint
    // analysis still saw err.message strings flowing into the sink
    // when the message embedded a stack-shaped substring without the
    // leading newline. The expanded last-mile scrub strips three
    // additional shapes the structural scrub may miss when the
    // payload is buried in a non-error-shaped field. These
    // assertions pin those shapes so a regression to the narrower
    // pattern would be caught.
    it('strips a parenthesised `at <fn> (...)` frame embedded in a non-error key', () => {
      // `arbitrary` is NOT in ERROR_SHAPED_KEYS, so the structural scrub
      // does NOT touch it. The egress chain MUST still strip the frame
      // shape (`at <fn> (...)`) so the path inside leaks no filesystem
      // layout. The egress chain only neutralises stack-frame TOKENS,
      // not bare paths — see the `preserves legitimate paths` test
      // above for the negative side of that contract.
      const errMsg =
        "first frame at handler (/Users/runner/work/dkg/dkg/packages/foo/src/bar.ts:42:7) trailing";
      const { body } = captureJsonResponse(500, {
        ok: false,
        payload: { arbitrary: errMsg },
      });
      expect(body.payload.arbitrary).not.toMatch(/bar\.ts/);
      expect(body.payload.arbitrary).not.toMatch(/:42:7/);
      expect(body.payload.arbitrary).not.toMatch(/\/Users\/runner/);
      expect(body.payload.arbitrary).toContain('first frame');
      expect(body.payload.arbitrary).toContain('trailing');
    });

    it('strips an unparenthesised `at <path>:line:col` frame in a non-error key', () => {
      // The most common Node.js inline frame shape — `at handler:42:7`
      // without surrounding parens — must be neutralised by the egress
      // chain because the structural scrub does not run on
      // non-error-shaped keys.
      const errMsg = 'failure at handler:42:7 happened';
      const { body } = captureJsonResponse(500, {
        ok: false,
        payload: { context: errMsg },
      });
      expect(body.payload.context).not.toMatch(/at handler:\d+:\d+/);
      expect(body.payload.context).toContain('failure');
      expect(body.payload.context).toContain('happened');
    });

    // -----------------------------------------------------------
    // — http-utils.ts:328). The earlier
    // expanded egress regex `\s+at\s+(?:[^\s()"]+\s+)?\([^)"\n]+\)`
    // matched any `(stuff)` after an `at <word>`, so a perfectly
    // legitimate body like
    //   { text: "meet at lunch (cafeteria)" }
    // was rewritten to `{"text":"meet"}` because the regex chewed
    // through ` at lunch (cafeteria)` thinking it was a v8 frame.
    // The fix is to require the parenthesised body to actually look
    // like a v8 frame location (`:NUM:NUM`, `<anonymous>`, `native`,
    // or `eval ...`). These tests pin the truthful positive AND
    // negative behaviour so the regex cannot drift back to the loose
    // form that ate user data.
    // -----------------------------------------------------------
    it('preserves "at WORD (PARENS)" payloads that are NOT stack frames (the original "meet at lunch (cafeteria)" lure)', () => {
      const { body } = captureJsonResponse(200, {
        ok: true,
        text: 'meet at lunch (cafeteria)',
      });
      expect(body.text).toBe('meet at lunch (cafeteria)');
    });

    it('preserves the bot\'s exact reproduction case verbatim', () => {
      // The bot showed `jsonResponse(res, 200, { text: "meet at lunch (cafeteria)" })`
      // collapsing to `{"text":"meet"}`. Pin the exact shape so any
      // future regression of this regex tightening is caught.
      const data = { text: 'meet at lunch (cafeteria)' };
      const { body } = captureJsonResponse(200, data);
      expect(body).toEqual(data);
    });

    it('preserves a wide variety of "at <word> (<word>)" prose shapes', () => {
      const phrases = [
        'meet at lunch (cafeteria)',
        'served at table (window seat)',
        'arrives at noon (sharp)',
        'speaking at conference (Tuesday)',
        'live at venue (downtown stage)',
        'fired at target (bullseye)',
        'meet at gate (B12)',
        'compiled at runtime (lazy)',
        'happens at level (3)', // the digits in the parens used to be safe but
        // the sub-pattern `[^)"\n]+` plus the relaxed boundaries used to be
        // dangerous when combined with `at WORD`; the tightening keeps it safe.
      ];
      for (const phrase of phrases) {
        const { body } = captureJsonResponse(200, { msg: phrase });
        expect(body.msg, `phrase preserved: "${phrase}"`).toBe(phrase);
      }
    });

    it('STILL strips a real v8-shaped frame `at fn (file.js:LINE:COL)` from non-error keys (positive case)', () => {
      // Make sure tightening did NOT regress the actual stack-frame
      // stripping responsibility — the `:NUM:NUM` suffix branch must
      // continue to fire.
      const errMsg = 'first frame at handler (/Users/runner/work/dkg/foo.ts:42:7) trailing';
      const { body } = captureJsonResponse(500, {
        ok: false,
        payload: { context: errMsg },
      });
      expect(body.payload.context).not.toMatch(/foo\.ts/);
      expect(body.payload.context).not.toMatch(/:42:7/);
      expect(body.payload.context).toContain('first frame');
      expect(body.payload.context).toContain('trailing');
    });

    it('STILL strips `at <anonymous>` and `at native` v8 sentinels', () => {
      // Anonymous and native frames have no `:LINE:COL`, so the
      // tightened regex must include them as explicit alternatives
      // (otherwise tightening would have leaked anonymous frames).
      const cases = [
        { msg: 'oops at fn (<anonymous>) cleanup', shouldNotContain: 'at fn (<anonymous>)' },
        { msg: 'crash at builtin (native) recovery', shouldNotContain: 'at builtin (native)' },
      ];
      for (const { msg, shouldNotContain } of cases) {
        const { body } = captureJsonResponse(500, { ok: false, payload: { context: msg } });
        expect(body.payload.context, `case "${msg}" was stripped`).not.toContain(shouldNotContain);
      }
    });

    it('tightening does not introduce ReDoS on adversarial "at WORD (...)" inputs', () => {
      // Belt-and-suspenders: the new regex has a non-greedy `*?` and
      // anchors. Hammer it with a long input that almost matches but
      // doesn't, to make sure backtracking stays linear.
      const adversarial = ' at fn (' + 'a'.repeat(2000) + ' no colon line col' + ')';
      const start = Date.now();
      const { body } = captureJsonResponse(500, { msg: adversarial });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(200);
      // No `:line:col` inside the parens, so the tightened regex
      // must NOT match — the user's text round-trips intact.
      expect(body.msg).toBe(adversarial);
    });

    it('preserves legitimate `.json` / `.txt` paths in non-error fields', () => {
      // The egress chain MUST NOT mangle bare absolute paths that
      // legitimately appear in non-error response shapes — they are
      // not stack-trace tokens. `stripStackFrames` only redacts paths
      // INSIDE error-shaped keys; everything else has to round-trip
      // unchanged or the daemon's `filePath` / `path` / `endpoint`
      // contracts break for callers.
      const { body } = captureJsonResponse(200, {
        ok: true,
        filePath: '/var/data/dkg/foo.json',
        path: '/var/data/dkg/manifest.txt',
        endpoint: 'http://localhost:7777/api/query',
      });
      expect(body.filePath).toBe('/var/data/dkg/foo.json');
      expect(body.path).toBe('/var/data/dkg/manifest.txt');
      expect(body.endpoint).toBe('http://localhost:7777/api/query');
    });

    // -----------------------------------------------------------
    // http-utils.ts:343). The 3-step
    // last-mile regex chain (the .replace(/\\n\s+at .../g, "") /
    // expanded `at … (…)` / standalone `at file:NUM:NUM` cleanup
    // pass) used to run on EVERY response body unconditionally.
    // CodeQL js/stack-trace-exposure is a data-flow alert about
    // err.message → res.end(body): exclusively an error-path
    // concern. So when a successful (status < 400) payload
    // legitimately CONTAINED v8-frame-shaped substrings — e.g. a
    // search result for an issue title that copy-pastes a stack
    // trace, a SPARQL literal embedding "at fn (file:10:5)", or a
    // logging tool surfacing user-submitted error reports — the
    // regex would silently elide those substrings from the
    // response, with NO indication of the rewrite. The fix
    // gates the regex chain on `status >= 400`. These tests pin
    // both the gate (success-path verbatim round-trip) AND the
    // non-regression (error-path stripping still fires).
    // -----------------------------------------------------------
    it('[r31-10] success (200) body containing v8-shaped frames round-trips VERBATIM (CodeQL pacifier must NOT corrupt successful payloads)', () => {
      // The bot's exact concern: a 200 response with literal text
      // containing v8 frame syntax. the third
      // last-mile regex (`/\s+at\s+[^\s()":]+:\d+:\d+/g`) would
      // have stripped " at fn:10:5" from the title — silently
      // mutating the user's data.
      const data = {
        ok: true,
        results: [
          {
            title: 'Bug report: crash at handler:10:5',
            body: 'Trace shows handler:10:5 invoking parser:42:13 invoking lexer:7:2',
          },
        ],
      };
      const { body } = captureJsonResponse(200, data);
      expect(body).toEqual(data);
    });

    it('[r31-10] success (200) body with multi-line v8 frame text round-trips VERBATIM', () => {
      // The first last-mile regex (`/\\n\s+at [^"\n]+/g`) used
      // to chew through any "\n   at <text>" continuation lines
      // — including legitimate multi-line user content. Pin
      // the success-path round-trip.
      const data = {
        ok: true,
        log: 'Search result:\n   at module/foo (frame 1)\n   at module/bar (frame 2)',
      };
      const { body } = captureJsonResponse(200, data);
      expect(body).toEqual(data);
    });

    it('[r31-10] success (201, 204, 302, 399) all preserve v8-shaped frame text — full success/redirect range is gated off', () => {
      // The gate is `status >= 400`, so the entire 1xx / 2xx /
      // 3xx range must round-trip user data verbatim. Hammer
      // the boundary to make sure no off-by-one regression
      // (e.g. `> 400`) ever leaks the regex pass into the
      // success/redirect range.
      const successStatuses = [100, 200, 201, 204, 301, 302, 308, 399];
      for (const status of successStatuses) {
        const data = {
          ok: true,
          msg: 'reads at config:42:7 then writes at output:1:1',
        };
        const { body } = captureJsonResponse(status, data);
        expect(body, `status ${status} preserves v8-shaped frame text`).toEqual(data);
      }
    });

    it('[r31-10] error (400) STILL strips v8-shaped frames — gate must FIRE at the boundary', () => {
      // 400 is the lower boundary of the gate. The regex chain
      // must engage exactly at `status === 400` so the CodeQL
      // pacifier responsibility is preserved on error responses.
      const errMsg = 'parse failed at handler (/srv/app/handler.js:42:7) bailing out';
      const { body } = captureJsonResponse(400, { ok: false, error: errMsg });
      expect(body.error).not.toMatch(/handler\.js/);
      expect(body.error).not.toMatch(/:42:7/);
      expect(body.error).toContain('parse failed');
    });

    it('[r31-10] error (500, 502, 503) STILL strips bare `at file:LINE:COL` frames — gate must fire across the error range', () => {
      // The third last-mile regex (`/\s+at\s+[^\s()":]+:\d+:\d+/g`)
      // is the one that previously corrupted success bodies. Pin
      // that it CONTINUES to fire on the error range.
      const errorStatuses = [500, 502, 503];
      for (const status of errorStatuses) {
        const errMsg = 'crash at handler:10:5 then bailout';
        const { body } = captureJsonResponse(status, { ok: false, error: errMsg });
        expect(body.error, `status ${status} still strips bare frame`).not.toMatch(/at handler:10:5/);
        expect(body.error).toContain('crash');
        expect(body.error).toContain('bailout');
      }
    });

    it('[r31-10] error (500) STILL strips multi-line `\\n   at <fn>` continuation frames', () => {
      // The first last-mile regex (`/\\n\s+at [^"\n]+/g`)
      // strips serialised continuation lines from JSON-encoded
      // error strings — must continue to fire on errors.
      const errMsg = 'parse failed\n   at handler\n   at lexer\n   at runner';
      const { body } = captureJsonResponse(500, { ok: false, error: errMsg });
      expect(body.error).toContain('parse failed');
      expect(body.error).not.toMatch(/at handler/);
      expect(body.error).not.toMatch(/at lexer/);
      expect(body.error).not.toMatch(/at runner/);
    });

    it('[r31-10] CodeQL js/stack-trace-exposure compliance: an `err.message` carrying a real v8 stack still gets scrubbed when surfaced as a 500 error response', () => {
      // The end-to-end CodeQL alert path: `try { ... } catch (e) {
      // jsonResponse(res, 500, { error: e.message }) }` where
      // `e.message` is a real Node.js error with full v8 stack.
      // Pin that this scrub still happens after the r31-10
      // narrowing.
      const realErrorMessage =
        'ENOENT: no such file or directory, open \'/srv/app/missing.json\'\n' +
        '    at Object.openSync (node:fs:603:3)\n' +
        '    at readFileSync (node:fs:471:35)\n' +
        '    at handler (/srv/app/dist/handler.js:42:7)\n' +
        '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)';
      const { body } = captureJsonResponse(500, {
        ok: false,
        error: realErrorMessage,
      });
      expect(body.error).toContain('ENOENT');
      expect(body.error).not.toMatch(/node:fs/);
      expect(body.error).not.toMatch(/handler\.js/);
      expect(body.error).not.toMatch(/processTicksAndRejections/);
    });
  });
});

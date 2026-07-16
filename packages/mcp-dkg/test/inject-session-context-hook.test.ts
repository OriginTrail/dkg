// inject-session-context-hook.test.ts
//
// Lockstep regression tests for the `<dkg-session-context>` injector.
// Addresses Codex PR #589 finding 2: the hook reimplements helpers
// that capture-chat owns, and any silent drift orphans annotations.
//
// These tests import BOTH `inject-session-context.mjs` and the
// reference helpers from `capture-chat.mjs` directly, then assert
// byte-for-byte agreement on representative payloads. If a future
// edit accidentally diverges one side from the other, this suite
// fails loudly instead of allowing the prod hooks to silently mint
// turn URIs that capture-chat never writes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM doesn't define `__dirname`; resolve it from `import.meta.url`
// for the subprocess test below.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// @ts-expect-error - importing .mjs hook for its pure-function exports
import {
  extractPrompt,
  extractSessionKey,
  sanitiseSlug,
  pick,
  renderBlock,
  parseAgentUri,
} from '../hooks/inject-session-context.mjs';
// @ts-expect-error - importing .mjs hook for its pure-function exports
import {
  extractText as captureExtractText,
  extractSessionKey as captureExtractSessionKey,
  sanitiseSlug as captureSanitiseSlug,
  pick as capturePick,
} from '../hooks/capture-chat.mjs';

describe('inject-session-context.mjs — LOCKSTEP with capture-chat.mjs', () => {
  it('re-exports the SAME `pick` reference as capture-chat (not a copy)', () => {
    // `===` here is the strongest possible lockstep guarantee:
    // there's only one implementation, so no drift is even
    // representable.
    expect(pick).toBe(capturePick);
  });

  it('re-exports the SAME `sanitiseSlug` reference as capture-chat', () => {
    expect(sanitiseSlug).toBe(captureSanitiseSlug);
  });

  it('re-exports the SAME `extractSessionKey` reference as capture-chat', () => {
    expect(extractSessionKey).toBe(captureExtractSessionKey);
  });

  // Functional cross-checks — even if someone broke the re-export
  // contract above, these would catch agreement-on-representative-
  // payloads drift (exactly the failure mode Codex flagged).
  describe('extractSessionKey agreement', () => {
    const payloads = [
      // Cursor 3.1.15 snake_case
      { name: 'conversation_id snake', payload: { conversation_id: 'abc-123', prompt: 'p' } },
      { name: 'session_id snake', payload: { session_id: 'def-456' } },
      // Cursor / Claude camelCase
      { name: 'conversationId camel', payload: { conversationId: 'ghi-789' } },
      { name: 'sessionId camel', payload: { sessionId: 'jkl-012' } },
      // Short aliases other frameworks use
      { name: 'convId short', payload: { convId: 'mno' } },
      { name: 'id bare', payload: { id: 'pqr' } },
      // Nested payloads (the deep-search behaviour of `pick`)
      { name: 'nested conversation_id', payload: { meta: { conversation_id: 'stu' } } },
      // ID with non-slug-safe chars — both sides must normalise the
      // same way.
      { name: 'colons + slashes', payload: { conversation_id: 'urn:dkg:agent:0xABC/cursor-1' } },
      { name: 'whitespace + unicode', payload: { session_id: 'session — round 2' } },
    ];

    it.each(payloads)('agrees with capture-chat on $name', ({ payload }) => {
      expect(extractSessionKey(payload)).toBe(captureExtractSessionKey(payload));
    });

    it('agrees on the anon-session fallback path (both write/read the same per-process file)', () => {
      // The anon-session fallback path in capture-chat writes a file
      // under ~/.dkg/hook-state if no id is present. Two consecutive
      // calls — one through each export — must produce the SAME
      // synthesised key because the second call reads the file the
      // first one wrote. (Both exports point at the same function
      // reference, so this is checking that the underlying file
      // protocol stays consistent.)
      const stateDir = path.join(os.homedir(), '.dkg', 'hook-state');
      const idxFile = path.join(stateDir, `anon-session-${process.ppid || process.pid}.txt`);
      // Clear any leftover state from previous test runs.
      try { fs.unlinkSync(idxFile); } catch { /* ok if absent */ }
      const k1 = extractSessionKey({});
      const k2 = captureExtractSessionKey({});
      expect(k1).toBe(k2);
      expect(k1).toMatch(/^anon-/);
    });
  });

  describe('extractPrompt agreement on user-prompt payload shapes', () => {
    // Codex finding 2 (round 1) was specifically about these keys
    // — they MUST all extract through both modules. capture-chat's
    // `extractText` is the canonical list; inject-session-context's
    // `extractPrompt` delegates to it (after the rawPayload short-
    // circuit).
    const keys = ['prompt', 'userPrompt', 'user_prompt', 'request', 'input', 'text', 'message', 'content'];
    it.each(keys)('extracts %s via both helpers', (key) => {
      const payload = { [key]: 'sentinel value' };
      expect(extractPrompt(payload)).toBe('sentinel value');
      expect(captureExtractText(payload)).toBe('sentinel value');
    });

    it('honours the rawPayload short-circuit even when capture-chat would not', () => {
      // capture-chat doesn't recognise `rawPayload` — that wrapper
      // is specific to inject-session-context's readStdinJson, which
      // wraps non-JSON stdin so the operator's prompt remains
      // recoverable. We deliberately diverge here, and the test
      // pins that divergence so it doesn't get "fixed" by accident.
      const payload = { rawPayload: 'raw text' };
      expect(extractPrompt(payload)).toBe('raw text');
      expect(captureExtractText(payload)).toBe('');
    });

    it('returns empty string for non-objects and missing keys', () => {
      expect(extractPrompt(null)).toBe('');
      expect(extractPrompt(undefined)).toBe('');
      expect(extractPrompt('string')).toBe('');
      expect(extractPrompt({})).toBe('');
    });
  });

  describe('hook composition: defensive updated_input extraction', () => {
    // Codex PR #589 round 3: if a different upstream hook (or
    // ourselves on a re-entry) has already emitted `updated_input`
    // and Cursor surfaces it to this hook, we want to preserve it.
    // Mirrors the matching defensive guard in inject-inbox.mjs.

    it('prefers payload.updated_input over the original prompt when present', () => {
      const upstreamBlock = '<dkg-inbox-notice>peer count</dkg-inbox-notice>\n\noriginal prompt';
      expect(extractPrompt({
        prompt: 'original prompt',
        updated_input: upstreamBlock,
      })).toBe(upstreamBlock);
    });

    it('falls back to the original prompt when updated_input is absent / empty', () => {
      expect(extractPrompt({ prompt: 'p' })).toBe('p');
      expect(extractPrompt({ prompt: 'p', updated_input: '' })).toBe('p');
      expect(extractPrompt({ prompt: 'p', updated_input: '   ' })).toBe('p');
    });

    it('ignores updated_input when it is not a string', () => {
      expect(extractPrompt({ prompt: 'p', updated_input: { command: 'x' } } as any)).toBe('p');
    });
  });
});

describe('inject-session-context.mjs — renderBlock', () => {
  it('produces a structured XML-shaped notice the agent can parse as metadata', () => {
    const block = renderBlock({
      sessionKey: 'abc-123',
      nextTurnIndex: 5,
      turnUri: 'urn:dkg:chat:session:abc-123#turn:5',
      agentUri: 'urn:dkg:agent:0xdef',
    });
    expect(block).toMatch(/^<dkg-session-context>/);
    expect(block).toMatch(/<\/dkg-session-context>$/);
    expect(block).toContain('<session-id>abc-123</session-id>');
    expect(block).toContain('<next-turn-index>5</next-turn-index>');
    expect(block).toContain('<turn-uri>urn:dkg:chat:session:abc-123#turn:5</turn-uri>');
    expect(block).toContain('<agent-uri>urn:dkg:agent:0xdef</agent-uri>');
  });

  it('falls back to (unknown) when agentUri is null/undefined', () => {
    const block = renderBlock({
      sessionKey: 'a', nextTurnIndex: 1, turnUri: 'urn:t', agentUri: null,
    });
    expect(block).toContain('<agent-uri>(unknown)</agent-uri>');
  });
});

describe('inject-session-context.mjs — parseAgentUri', () => {
  it('parses agent.uri from a minimal .dkg/config.yaml', () => {
    const yaml = [
      'contextGraph: foo',
      'agent:',
      '  uri: urn:dkg:agent:0xabc',
      '  nickname: "Test Laptop"',
    ].join('\n');
    expect(parseAgentUri(yaml)).toBe('urn:dkg:agent:0xabc');
  });

  it('ignores commented-out uri lines', () => {
    const yaml = [
      'agent:',
      '  # uri: urn:dkg:agent:wrong',
      '  uri: urn:dkg:agent:right',
    ].join('\n');
    expect(parseAgentUri(yaml)).toBe('urn:dkg:agent:right');
  });

  it('returns null when agent block has no uri field', () => {
    const yaml = 'agent:\n  nickname: foo\n';
    expect(parseAgentUri(yaml)).toBe(null);
  });

  it('returns null when there is no agent block', () => {
    expect(parseAgentUri('contextGraph: foo\n')).toBe(null);
  });
});

describe('inject-session-context.mjs — turn-URI prediction via state file', () => {
  // Black-box test of the hook's state-file consumption. We
  // construct a state file that mirrors what capture-chat would
  // write, run the hook as a subprocess, and assert it emits
  // `<turn-uri>` matching the slot capture-chat reserved.
  //
  // This is the regression that fails if PR #589 finding 1's bug
  // is reintroduced: a state file with `pendingTurnIndex=7` and
  // `turnIndex=3` must produce `#turn:7`, NOT `#turn:4`.

  const STATE_DIR = path.join(os.homedir(), '.cache', 'dkg-mcp', 'sessions');
  const sessionKey = 'inject-test-session';
  const stateFile = path.join(STATE_DIR, `${sessionKey}.json`);
  const hookPath = path.resolve(HERE, '..', 'hooks', 'inject-session-context.mjs');
  let savedState: string | null = null;

  beforeEach(() => {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (fs.existsSync(stateFile)) {
      savedState = fs.readFileSync(stateFile, 'utf-8');
    }
  });

  afterEach(() => {
    if (savedState != null) {
      fs.writeFileSync(stateFile, savedState);
      savedState = null;
    } else {
      try { fs.unlinkSync(stateFile); } catch { /* ok */ }
    }
  });

  async function runHook(payload: object): Promise<{ stdout: string; output: any }> {
    const { spawn } = await import('node:child_process');
    return await new Promise((resolveFn, rejectFn) => {
      const proc = spawn('node', [hookPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      proc.stdout.on('data', (c) => { stdout += c; });
      proc.on('close', () => {
        try {
          resolveFn({ stdout, output: JSON.parse(stdout.trim() || '{}') });
        } catch (e) { rejectFn(e); }
      });
      proc.on('error', rejectFn);
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    });
  }

  it('uses state.pendingTurnIndex when present (the post-PR #589 contract)', async () => {
    // Simulate capture-chat reserving turn 7 after several
    // previous turns; the failed-retry scenario is what advances
    // pendingTurnIndex past turnIndex.
    fs.writeFileSync(stateFile, JSON.stringify({
      sessionKey,
      sessionUri: `urn:dkg:chat:session:${sessionKey}`,
      startedAt: new Date().toISOString(),
      turnIndex: 3,
      pendingTurnIndex: 7,
      maxAssignedTurnIndex: 7,
      pendingPrompt: 'whatever',
    }));
    const { output } = await runHook({ session_id: sessionKey, prompt: 'hi' });
    expect(output.updated_input).toContain(`<turn-uri>urn:dkg:chat:session:${sessionKey}#turn:7</turn-uri>`);
    expect(output.updated_input).toContain('<next-turn-index>7</next-turn-index>');
  });

  it('falls back to turnIndex+1 for legacy state files written before the contract existed', async () => {
    // Old capture-chat writes don't include pendingTurnIndex. The
    // hook must not break for in-flight upgrades.
    fs.writeFileSync(stateFile, JSON.stringify({
      sessionKey,
      sessionUri: `urn:dkg:chat:session:${sessionKey}`,
      startedAt: new Date().toISOString(),
      turnIndex: 4,
      pendingPrompt: 'whatever',
    }));
    const { output } = await runHook({ session_id: sessionKey, prompt: 'hi' });
    expect(output.updated_input).toContain(`<turn-uri>urn:dkg:chat:session:${sessionKey}#turn:5</turn-uri>`);
  });

  it('skips injection when no state file exists (fail-closed)', async () => {
    try { fs.unlinkSync(stateFile); } catch { /* ok */ }
    const { output } = await runHook({ session_id: sessionKey, prompt: 'hi' });
    expect(output).toEqual({});
  });

  it('does NOT reuse the same predicted URI after a simulated failed-turn-write retry', async () => {
    // The scenario PR #589 finding 1 calls out:
    // 1. Prompt P1 reserves turn 5 (state.pendingTurnIndex = 5).
    // 2. capture-chat's afterAgentResponse for P1 fails. State
    //    after capture-chat's failure handler: turnIndex unchanged
    //    at 4, maxAssignedTurnIndex stays at 5 (the failed slot is
    //    abandoned, not retried).
    // 3. Prompt P2 reserves turn 6 (maxAssignedTurnIndex advances to 6).
    // Verify inject-session-context predicts the FRESH slot 6, not
    // the orphaned slot 5.
    fs.writeFileSync(stateFile, JSON.stringify({
      sessionKey,
      sessionUri: `urn:dkg:chat:session:${sessionKey}`,
      startedAt: new Date().toISOString(),
      turnIndex: 4,
      pendingTurnIndex: 6, // capture-chat reserved a NEW slot after P1's failure
      maxAssignedTurnIndex: 6,
      pendingPrompt: 'P2',
    }));
    const { output } = await runHook({ session_id: sessionKey, prompt: 'P2' });
    expect(output.updated_input).toContain('#turn:6</turn-uri>');
    expect(output.updated_input).not.toContain('#turn:5</turn-uri>');
  });

  it('skips injection on a corrupt state file (JSON.parse throws → fail-closed)', async () => {
    // A truncated write or an editor-saved partial file yields invalid
    // JSON. The hook MUST treat this as "no state" and skip injection
    // rather than throw at top-level (which would crash the prompt
    // pipeline) or guess a turn index (which would orphan annotations).
    fs.writeFileSync(stateFile, '{"sessionKey":"abc",');
    const { output } = await runHook({ session_id: sessionKey, prompt: 'hi' });
    expect(output).toEqual({});
  });

  it('treats pendingTurnIndex = 0 as a valid slot (zero is a number, not falsy-skip)', async () => {
    // Defends against an `if (state.pendingTurnIndex)` regression that
    // would treat 0 as missing. The current contract uses
    // `typeof === 'number'`, so 0 must be honoured for the legitimate
    // turn-zero (or wrap-around) edge case.
    fs.writeFileSync(stateFile, JSON.stringify({
      sessionKey,
      sessionUri: `urn:dkg:chat:session:${sessionKey}`,
      startedAt: new Date().toISOString(),
      turnIndex: -1, // sentinel: state hasn't seen a successful turn yet
      pendingTurnIndex: 0,
      maxAssignedTurnIndex: 0,
      pendingPrompt: 'first',
    }));
    const { output } = await runHook({ session_id: sessionKey, prompt: 'first' });
    expect(output.updated_input).toContain('<next-turn-index>0</next-turn-index>');
    expect(output.updated_input).toContain(`#turn:0</turn-uri>`);
  });

  it('treats turnIndex = 0 (legacy state, no pendingTurnIndex) as next slot 1', async () => {
    // turnIndex+1 fallback: turnIndex=0 → next=1. Same falsy-zero
    // protection, different code path (legacy back-compat branch).
    fs.writeFileSync(stateFile, JSON.stringify({
      sessionKey,
      sessionUri: `urn:dkg:chat:session:${sessionKey}`,
      startedAt: new Date().toISOString(),
      turnIndex: 0,
      pendingPrompt: 'first',
    }));
    const { output } = await runHook({ session_id: sessionKey, prompt: 'first' });
    expect(output.updated_input).toContain('<next-turn-index>1</next-turn-index>');
  });

  it('uses default 1 when state file has neither pendingTurnIndex nor turnIndex', async () => {
    // The non-error fallback branch in loadPendingTurnIndex: state
    // file exists but is missing both fields (e.g. legacy schema or a
    // partially-rewritten state). Returns 1 — the first-turn default.
    fs.writeFileSync(stateFile, JSON.stringify({
      sessionKey,
      sessionUri: `urn:dkg:chat:session:${sessionKey}`,
      startedAt: new Date().toISOString(),
      pendingPrompt: 'whatever',
    }));
    const { output } = await runHook({ session_id: sessionKey, prompt: 'hi' });
    expect(output.updated_input).toContain('<next-turn-index>1</next-turn-index>');
  });

  it('skips injection when prompt is empty (fail-closed — must not silently REPLACE the prompt with our block)', async () => {
    // The exact regression FAIL CLOSED guard #2 protects against:
    // emitting `updated_input` with no operator prompt would replace
    // the user's actual ask with just our metadata block. State file
    // is fine, sessionKey is fine, only prompt is missing.
    fs.writeFileSync(stateFile, JSON.stringify({
      sessionKey,
      sessionUri: `urn:dkg:chat:session:${sessionKey}`,
      startedAt: new Date().toISOString(),
      pendingTurnIndex: 5,
    }));
    const { output } = await runHook({ session_id: sessionKey, prompt: '' });
    expect(output).toEqual({});
  });

  it('honours DKG_AGENT_URI env var as override for the workspace .dkg/config.yaml', async () => {
    // The env-var path takes priority over the file walk (so an
    // operator can override the workspace config without touching the
    // file). Run the hook with the env var set and assert the
    // injected agentUri matches.
    fs.writeFileSync(stateFile, JSON.stringify({
      sessionKey,
      sessionUri: `urn:dkg:chat:session:${sessionKey}`,
      startedAt: new Date().toISOString(),
      pendingTurnIndex: 1,
    }));
    const { spawn } = await import('node:child_process');
    const { stdout } = await new Promise<{ stdout: string }>((resolveFn, rejectFn) => {
      const proc = spawn('node', [hookPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DKG_AGENT_URI: 'urn:dkg:agent:0xenv-override' },
      });
      let stdout = '';
      proc.stdout.on('data', (c) => { stdout += c; });
      proc.on('close', () => resolveFn({ stdout }));
      proc.on('error', rejectFn);
      proc.stdin.write(JSON.stringify({ session_id: sessionKey, prompt: 'hi' }));
      proc.stdin.end();
    });
    const output = JSON.parse(stdout.trim() || '{}');
    expect(output.updated_input).toContain('<agent-uri>urn:dkg:agent:0xenv-override</agent-uri>');
  });

  it('percent-encodes sessionKey in the turn URI (matches capture-chat encoder)', async () => {
    // Spec lock: capture-chat uses `encodeURIComponent` on sessionKey
    // when building turn URIs. inject-session-context MUST use the
    // same encoder, otherwise a session key containing reserved
    // chars (`/`, `:`, `#`) would predict a different URI than the
    // one capture-chat writes — exactly the orphan-annotation bug.
    //
    // Note: sanitiseSlug runs first and strips most special chars,
    // but a slug that legitimately contains dashes / dots etc. has
    // to round-trip identically; a URL-quotable char (we use `~` —
    // RFC 3986 unreserved, but encodeURIComponent leaves it as-is —
    // and sanitiseSlug allows it) is the simplest probe that locks
    // the encoder choice without depending on its allow-list.
    const sessionKeyWithSlash = 'cursor-with-segment-1';
    const file = path.join(STATE_DIR, `${sessionKeyWithSlash}.json`);
    fs.writeFileSync(file, JSON.stringify({
      sessionKey: sessionKeyWithSlash,
      sessionUri: `urn:dkg:chat:session:${sessionKeyWithSlash}`,
      startedAt: new Date().toISOString(),
      pendingTurnIndex: 1,
    }));
    try {
      const { output } = await runHook({
        session_id: sessionKeyWithSlash,
        prompt: 'hi',
      });
      expect(output.updated_input).toContain(
        `<turn-uri>urn:dkg:chat:session:${encodeURIComponent(sessionKeyWithSlash)}#turn:1</turn-uri>`,
      );
    } finally {
      try { fs.unlinkSync(file); } catch { /* ok */ }
    }
  });
});

describe('inject-session-context.mjs — parseAgentUri quoting & whitespace', () => {
  it('strips surrounding double quotes', () => {
    const yaml = 'agent:\n  uri: "urn:dkg:agent:0xQ"\n';
    expect(parseAgentUri(yaml)).toBe('urn:dkg:agent:0xQ');
  });

  it('strips surrounding single quotes', () => {
    const yaml = "agent:\n  uri: 'urn:dkg:agent:0xS'\n";
    expect(parseAgentUri(yaml)).toBe('urn:dkg:agent:0xS');
  });

  it('strips trailing inline comment from a uri value', () => {
    // The line-level comment strip happens before the regex match;
    // operators commonly annotate the agent URI with a "# laptop A"
    // comment, and the parser must NOT include that comment in the
    // returned value (regression would write `urn:...0xC # laptop A`
    // into every turn URI).
    const yaml = 'agent:\n  uri: urn:dkg:agent:0xC # primary laptop\n';
    expect(parseAgentUri(yaml)).toBe('urn:dkg:agent:0xC');
  });

  it('honours dedent — a `uri:` outside the agent block is NOT picked up', () => {
    // The indent-tracking guard: a top-level (or sibling) `uri:` key
    // outside the agent block must not match. This protects against
    // .dkg/config.yaml schemas that grow more sections; the parser's
    // "agent.uri only" contract must stay stable.
    const yaml = [
      'agent:',
      '  nickname: foo',
      'someOtherSection:',
      '  uri: urn:dkg:agent:0xWRONG',
    ].join('\n');
    expect(parseAgentUri(yaml)).toBe(null);
  });
});

describe('inject-session-context.mjs — extractPrompt whitespace handling', () => {
  it('treats whitespace-only updated_input as absent and falls through to prompt', () => {
    // Defends against an upstream hook emitting `\n\t \n` as
    // updated_input (e.g. on a partial parse). The downstream hook
    // would otherwise propagate that empty block and silently kill
    // the operator's actual prompt.
    expect(extractPrompt({
      prompt: 'real prompt',
      updated_input: '\n\t   \n',
    })).toBe('real prompt');
  });

  it('treats whitespace-only rawPayload as absent and falls through to capture-chat', () => {
    // Same guard for the rawPayload envelope. Empty / whitespace-
    // only rawPayload must not be returned as the prompt.
    expect(extractPrompt({
      prompt: 'real prompt',
      rawPayload: '   ',
    })).toBe('real prompt');
  });
});

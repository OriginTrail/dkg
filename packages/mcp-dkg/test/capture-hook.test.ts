import { describe, it, expect } from 'vitest';
import {
  parseDotDkgConfig,
  pick,
  extractText,
  extractSessionKey,
  extractMentionedUris,
  sanitiseSlug,
  buildPerTurnReminder,
} from '../hooks/capture-chat.mjs';

/**
 * Pure-function tests for the capture-chat hook. The hook runs on
 * every Cursor / Claude Code event and is the only piece of plumbing
 * with field-name guesses (Cursor 3.1.15 vs Claude Code vs future
 * tools). These tests pin the field-resolution behaviour so a future
 * Cursor payload-shape change is detected as a test failure rather
 * than silent capture loss.
 */

describe('parseDotDkgConfig — hand-rolled YAML loader', () => {
  it('parses flat keys', () => {
    const cfg = parseDotDkgConfig(`
contextGraph: dkg-code-project
autoShare: true
`);
    expect(cfg.contextGraph).toBe('dkg-code-project');
    expect(cfg.autoShare).toBe(true);
  });

  it('parses nested objects', () => {
    const cfg = parseDotDkgConfig(`
node:
  api: http://localhost:9201
  tokenFile: ../auth.token
agent:
  uri: urn:dkg:agent:cursor-branarakic
  speakerTool: cursor
`);
    expect(cfg.node.api).toBe('http://localhost:9201');
    expect(cfg.node.tokenFile).toBe('../auth.token');
    expect(cfg.agent.uri).toBe('urn:dkg:agent:cursor-branarakic');
    expect(cfg.agent.speakerTool).toBe('cursor');
  });

  it('strips quoted strings', () => {
    const cfg = parseDotDkgConfig(`
contextGraph: "dkg-code-project"
agent:
  uri: 'urn:dkg:agent:cursor-branarakic'
`);
    expect(cfg.contextGraph).toBe('dkg-code-project');
    expect(cfg.agent.uri).toBe('urn:dkg:agent:cursor-branarakic');
  });

  it('coerces booleans + integers', () => {
    const cfg = parseDotDkgConfig(`
autoShare: true
maxTurns: 100
private: false
`);
    expect(cfg.autoShare).toBe(true);
    expect(cfg.private).toBe(false);
    expect(cfg.maxTurns).toBe(100);
  });

  it('strips inline comments', () => {
    const cfg = parseDotDkgConfig(`
contextGraph: dkg-code-project   # the project ID
autoShare: true                    # spec default
`);
    expect(cfg.contextGraph).toBe('dkg-code-project');
    expect(cfg.autoShare).toBe(true);
  });

  it('handles empty / blank lines without crashing', () => {
    const cfg = parseDotDkgConfig(`

contextGraph: foo


agent:

  uri: bar

`);
    expect(cfg.contextGraph).toBe('foo');
    expect(cfg.agent.uri).toBe('bar');
  });
});

describe('pick — deep candidate-key resolver', () => {
  it('returns first matching key from candidates list', () => {
    const obj = { foo: 'first', bar: 'second' };
    expect(pick(obj, ['baz', 'foo', 'bar'])).toBe('first');
    expect(pick(obj, ['bar', 'foo'])).toBe('second');
  });

  it('descends into nested objects', () => {
    const obj = { meta: { details: { prompt: 'deep value' } } };
    expect(pick(obj, ['prompt'])).toBe('deep value');
  });

  it('returns undefined when no candidate matches', () => {
    expect(pick({ a: 1 }, ['b', 'c'])).toBeUndefined();
  });

  it('skips empty strings (treats them as not-found)', () => {
    const obj = { prompt: '', text: 'real value' };
    expect(pick(obj, ['prompt', 'text'])).toBe('real value');
  });

  it('coerces numbers + booleans to strings', () => {
    expect(pick({ count: 42 }, ['count'])).toBe('42');
    expect(pick({ ok: true }, ['ok'])).toBe('true');
  });

  it('caps recursion depth (no infinite loops on circular objects)', () => {
    const obj: any = { a: {} };
    obj.a.b = obj; // circular
    expect(() => pick(obj, ['nonexistent'])).not.toThrow();
  });
});

describe('extractText — payload prompt/response resolver', () => {
  it('finds Cursor 3.1.15 prompt field', () => {
    expect(extractText({ prompt: 'hello', conversation_id: 'x' })).toBe('hello');
  });

  it('finds Cursor 3.1.15 afterAgentResponse text field', () => {
    expect(extractText({ text: 'agent reply', model: 'claude-opus' })).toBe('agent reply');
  });

  it('finds Claude Code Stop event last_assistant_message', () => {
    expect(extractText({ session_id: 'x', last_assistant_message: 'CC reply' }))
      .toBe('CC reply');
  });

  it('finds camelCase variants (lastAssistantMessage)', () => {
    expect(extractText({ lastAssistantMessage: 'camel' })).toBe('camel');
  });

  it('finds nested fields via deep search', () => {
    expect(extractText({ data: { content: 'wrapped' } })).toBe('wrapped');
  });

  it('returns empty string when no candidate matches', () => {
    expect(extractText({ unknown_field: 'x' })).toBe('');
    expect(extractText({})).toBe('');
  });
});

describe('extractSessionKey — session ID resolver', () => {
  it('finds Cursor conversation_id', () => {
    expect(extractSessionKey({ conversation_id: 'cursor-uuid-123' }))
      .toBe('cursor-uuid-123');
  });

  it('finds Claude Code session_id', () => {
    expect(extractSessionKey({ session_id: 'cc-uuid-456' })).toBe('cc-uuid-456');
  });

  it('sanitises through sanitiseSlug (no path-traversal exploits)', () => {
    expect(extractSessionKey({ session_id: '../../etc/passwd' }))
      .not.toContain('../');
  });

  it('falls back to a unique per-invocation anon key when no id present', () => {
    // The old hour-bucket fallback (`anon-2026-04-20T14`) silently merged
    // unrelated conversations that happened to land in the same 60-minute
    // window. The new fallback is a randomised `anon-<timestamp>-<rand>`
    // persisted per shell process.
    const key = extractSessionKey({});
    expect(key).toMatch(/^anon-[a-z0-9]+-[a-z0-9]+$/);
    expect(key).not.toMatch(/^anon-\d{4}-\d{2}-\d{2}T\d{2}$/);
  });
});

describe('extractMentionedUris — regex backstop', () => {
  it('catches a single urn:dkg:* URI', () => {
    expect(extractMentionedUris('check urn:dkg:concept:foo'))
      .toEqual(['urn:dkg:concept:foo']);
  });

  it('catches multiple URIs in one string', () => {
    const text = 'see urn:dkg:decision:adopt-x and urn:dkg:task:do-y';
    expect(extractMentionedUris(text)).toEqual([
      'urn:dkg:decision:adopt-x',
      'urn:dkg:task:do-y',
    ]);
  });

  it('handles complex slugs with hyphens, dots, percent-encoding', () => {
    const text = 'urn:dkg:code:file:%40origintrail-official%2Fdkg-cli/src/index.ts';
    expect(extractMentionedUris(text)).toEqual([
      'urn:dkg:code:file:%40origintrail-official%2Fdkg-cli/src/index.ts',
    ]);
  });

  it('catches URIs across multiple text inputs (prompt + response)', () => {
    const prompt = 'analyse urn:dkg:decision:foo';
    const response = 'and consider urn:dkg:task:bar';
    expect(extractMentionedUris(prompt, response)).toEqual([
      'urn:dkg:decision:foo',
      'urn:dkg:task:bar',
    ]);
  });

  it('deduplicates URIs that appear in both prompt and response', () => {
    const prompt = 'about urn:dkg:concept:foo';
    const response = 'urn:dkg:concept:foo is interesting';
    expect(extractMentionedUris(prompt, response)).toEqual(['urn:dkg:concept:foo']);
  });

  it('strips trailing punctuation (period, comma, parens)', () => {
    expect(extractMentionedUris('see urn:dkg:concept:foo.'))
      .toEqual(['urn:dkg:concept:foo']);
    expect(extractMentionedUris('(urn:dkg:concept:bar)'))
      .toEqual(['urn:dkg:concept:bar']);
  });

  it('returns empty array when no URIs present', () => {
    expect(extractMentionedUris('just some text')).toEqual([]);
    expect(extractMentionedUris('')).toEqual([]);
    expect(extractMentionedUris(undefined as any, null as any)).toEqual([]);
  });
});

describe('sanitiseSlug — defensive session-key cleaner', () => {
  it('strips path-traversal characters', () => {
    expect(sanitiseSlug('../../../etc/passwd')).not.toContain('/');
    expect(sanitiseSlug('a/b/c')).not.toContain('/');
  });

  it('preserves hyphens, dots, underscores, alphanumerics', () => {
    expect(sanitiseSlug('Test_Session-123.foo'))
      .toBe('Test_Session-123.foo');
  });

  it('truncates to 80 chars', () => {
    const s = sanitiseSlug('x'.repeat(100));
    expect(s.length).toBeLessThanOrEqual(80);
  });
});

describe('buildPerTurnReminder — Phase 7B per-turn injection', () => {
  it('includes the session ID in the reminder body', () => {
    const md = buildPerTurnReminder('abc-123');
    expect(md).toContain('abc-123');
    expect(md).toContain('forSession');
    expect(md).toContain('dkg_annotate_turn');
  });

  it('stays under 600 chars (per-turn token budget)', () => {
    const md = buildPerTurnReminder('a-typical-session-uuid-of-normal-length-12345');
    expect(md.length).toBeLessThan(600);
  });

  it('mentions look-before-mint indirectly via the rule reference', () => {
    const md = buildPerTurnReminder('x');
    expect(md).toContain('.cursor/rules/dkg-annotate.mdc');
  });
});

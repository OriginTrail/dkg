import { describe, it, expect } from 'vitest';
import { resolveSyncAgentsMeta, parseBooleanEnv } from '../src/sync/requester/agents-meta-sync-config.js';

describe('resolveSyncAgentsMeta', () => {
  it('defaults a core (or any node) with no config and no env to false, so the durable-sync skip fires', () => {
    // No explicit config, no env override → do NOT fetch agents/_meta.
    expect(resolveSyncAgentsMeta(undefined, undefined)).toBe(false);
    // The resolved value is a strict boolean literal (not undefined), which the
    // requester skip in runDurableSync keys on (`syncAgentsMeta === false`).
    expect(resolveSyncAgentsMeta(undefined, undefined)).toStrictEqual(false);
  });

  it('re-enables fetching when DKG_SYNC_AGENTS_META=1', () => {
    expect(resolveSyncAgentsMeta(undefined, '1')).toBe(true);
  });

  it('honors truthy env spellings', () => {
    for (const raw of ['1', 'true', 'TRUE', 'on', 'yes', ' true ']) {
      expect(resolveSyncAgentsMeta(undefined, raw)).toBe(true);
    }
  });

  it('honors falsey env spellings', () => {
    for (const raw of ['0', 'false', 'off', 'no', '']) {
      expect(resolveSyncAgentsMeta(undefined, raw)).toBe(false);
    }
  });

  it('treats unrecognized env values as unset and falls through to the default false', () => {
    expect(resolveSyncAgentsMeta(undefined, 'maybe')).toBe(false);
  });

  it('gives explicit config precedence over env', () => {
    // Operator opted in via config → true even if env would say off.
    expect(resolveSyncAgentsMeta(true, '0')).toBe(true);
    // Operator opted out via config → false even if env would say on.
    expect(resolveSyncAgentsMeta(false, '1')).toBe(false);
  });
});

describe('parseBooleanEnv', () => {
  it('returns undefined for absent / empty / unrecognized values', () => {
    expect(parseBooleanEnv(undefined)).toBeUndefined();
    expect(parseBooleanEnv('')).toBeUndefined();
    expect(parseBooleanEnv('   ')).toBeUndefined();
    expect(parseBooleanEnv('maybe')).toBeUndefined();
  });

  it('parses recognized on/off spellings to strict booleans', () => {
    expect(parseBooleanEnv('1')).toBe(true);
    expect(parseBooleanEnv('YES')).toBe(true);
    expect(parseBooleanEnv('0')).toBe(false);
    expect(parseBooleanEnv('Off')).toBe(false);
  });
});

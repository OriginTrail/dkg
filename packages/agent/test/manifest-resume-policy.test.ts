import { describe, expect, it } from 'vitest';
import type { SyncCheckpointEntry } from '../src/sync/checkpoint/state.js';
import {
  resolveManifestCheckpointDecision,
  resolveResponderResumeDecision,
  resolveResponderSessionLossCleanup,
} from '../src/sync/requester/manifest-resume-policy.js';

const MANIFEST_A = `sha256:${'aa'.repeat(32)}` as const;
const MANIFEST_B = `sha256:${'bb'.repeat(32)}` as const;
const PREFIX = `sha256:${'cc'.repeat(32)}` as const;

function checkpoint(overrides: Partial<SyncCheckpointEntry> = {}): SyncCheckpointEntry {
  return {
    offset: 512,
    updatedAtMs: 1,
    expiresAtMs: 10_000,
    manifestDigest: MANIFEST_A,
    manifestPrefixDigest: PREFIX,
    responderSessionId: 'session-a',
    responderSessionExpiresAtMs: 9_000,
    responderSessionOffset: 512,
    ...overrides,
  };
}

describe('manifest resume policy', () => {
  it('keeps same-generation state and rebinds only a proven ordinary prefix', () => {
    expect(resolveManifestCheckpointDecision({
      checkpoint: checkpoint(),
      manifestDigest: MANIFEST_A,
      prefixDigestAtOffset: PREFIX,
      hasExactAssetFilter: false,
    })).toEqual({ kind: 'keep' });

    expect(resolveManifestCheckpointDecision({
      checkpoint: checkpoint(),
      manifestDigest: MANIFEST_B,
      prefixDigestAtOffset: PREFIX,
      hasExactAssetFilter: false,
    })).toEqual({ kind: 'rebind-and-prime', prefixDigest: PREFIX });

    expect(resolveManifestCheckpointDecision({
      checkpoint: checkpoint(),
      manifestDigest: MANIFEST_B,
      prefixDigestAtOffset: PREFIX,
      hasExactAssetFilter: true,
    })).toEqual({ kind: 'reset' });
  });

  it('never guesses a raw coordinate after the responder token is lost', () => {
    expect(resolveResponderResumeDecision({
      checkpoint: checkpoint({ responderSessionId: undefined }),
      usesPageSession: true,
      savedResponderSessionOffset: undefined,
      manifestRebindNeedsPriming: false,
    })).toEqual({ kind: 'reset-unmappable', verifiedOffset: 0, rawOffset: 0 });

    expect(resolveResponderResumeDecision({
      checkpoint: checkpoint({ responderSessionId: undefined }),
      usesPageSession: true,
      savedResponderSessionOffset: undefined,
      manifestRebindNeedsPriming: true,
    })).toEqual({ kind: 'prime', verifiedOffset: 512, rawOffset: 512 });
  });

  it('clears only the token when the verified manifest prefix proves rotation safe', () => {
    expect(resolveResponderSessionLossCleanup({
      usesPageSession: true,
      hasExactAssetFilter: false,
      checkpoint: checkpoint(),
      manifestDigest: MANIFEST_A,
      verifiedOffset: 512,
      rawOffset: 512,
      prefixDigestAtOffset: PREFIX,
      supportsSessionClear: true,
    })).toBe('clear-session');
    expect(resolveResponderSessionLossCleanup({
      usesPageSession: true,
      hasExactAssetFilter: false,
      checkpoint: checkpoint(),
      manifestDigest: MANIFEST_A,
      verifiedOffset: 512,
      rawOffset: 640,
      prefixDigestAtOffset: PREFIX,
      supportsSessionClear: true,
    })).toBe('clear-checkpoint');
  });
});

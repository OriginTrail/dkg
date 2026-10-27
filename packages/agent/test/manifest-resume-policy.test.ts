import { describe, expect, it } from 'vitest';
import type { SyncCheckpointEntry } from '../src/sync/checkpoint/state.js';
import {
  resolveManifestCheckpointDecision,
  resolveManifestResumePlan,
  resolveResponderResumeDecision,
  resolveResponderSessionLossCleanup,
} from '../src/sync/requester/manifest-resume-policy.js';

const MANIFEST_A = `sha256:${'aa'.repeat(32)}` as const;
const MANIFEST_B = `sha256:${'bb'.repeat(32)}` as const;
const PREFIX = `sha256:${'cc'.repeat(32)}` as const;
const OTHER_PREFIX = `sha256:${'dd'.repeat(32)}` as const;

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

/** What a store returns once the responder token has expired or was cleared. */
function tokenless(overrides: Partial<SyncCheckpointEntry> = {}): SyncCheckpointEntry {
  return checkpoint({
    responderSessionId: undefined,
    responderSessionExpiresAtMs: undefined,
    responderSessionOffset: undefined,
    ...overrides,
  });
}

describe('manifest resume policy', () => {
  it('keeps same-generation state and rebinds only a proven ordinary prefix', () => {
    expect(resolveManifestCheckpointDecision({
      checkpoint: checkpoint(),
      manifestDigest: MANIFEST_A,
      prefixDigestAtOffset: PREFIX,
      hasExactAssetFilter: false,
    })).toEqual({ kind: 'keep', primeable: true });

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

  it('primes a proven prefix whose responder token is gone instead of restarting it', () => {
    // Same generation: the verified prefix is reused through a primed session.
    expect(resolveManifestCheckpointDecision({
      checkpoint: tokenless(),
      manifestDigest: MANIFEST_A,
      prefixDigestAtOffset: PREFIX,
      hasExactAssetFilter: false,
    })).toEqual({ kind: 'keep', primeable: true });
    // A newer generation with the same prefix rebinds it the same way.
    expect(resolveManifestCheckpointDecision({
      checkpoint: tokenless(),
      manifestDigest: MANIFEST_B,
      prefixDigestAtOffset: PREFIX,
      hasExactAssetFilter: false,
    })).toEqual({ kind: 'rebind-and-prime', prefixDigest: PREFIX });
    // A changed prefix, or exact-asset state, still starts over.
    expect(resolveManifestCheckpointDecision({
      checkpoint: tokenless(),
      manifestDigest: MANIFEST_B,
      prefixDigestAtOffset: OTHER_PREFIX,
      hasExactAssetFilter: false,
    })).toEqual({ kind: 'reset' });
    expect(resolveManifestCheckpointDecision({
      checkpoint: tokenless(),
      manifestDigest: MANIFEST_A,
      prefixDigestAtOffset: PREFIX,
      hasExactAssetFilter: true,
    })).toEqual({ kind: 'keep' });
    // A terminal offset of the same generation has no next graph to resume
    // into; a newer generation may append to it.
    expect(resolveManifestCheckpointDecision({
      checkpoint: tokenless({ terminal: true }),
      manifestDigest: MANIFEST_A,
      prefixDigestAtOffset: PREFIX,
      hasExactAssetFilter: false,
    })).toEqual({ kind: 'keep' });
    expect(resolveManifestCheckpointDecision({
      checkpoint: tokenless({ terminal: true }),
      manifestDigest: MANIFEST_B,
      prefixDigestAtOffset: PREFIX,
      hasExactAssetFilter: false,
    })).toEqual({ kind: 'rebind-and-prime', prefixDigest: PREFIX });
  });

  it('never primes a held token whose raw coordinate differs from the verified one', () => {
    expect(resolveManifestCheckpointDecision({
      checkpoint: checkpoint({ responderSessionOffset: 640 }),
      manifestDigest: MANIFEST_A,
      prefixDigestAtOffset: PREFIX,
      hasExactAssetFilter: false,
    })).toEqual({ kind: 'keep' });
    expect(resolveManifestCheckpointDecision({
      checkpoint: checkpoint({ responderSessionOffset: 640 }),
      manifestDigest: MANIFEST_B,
      prefixDigestAtOffset: PREFIX,
      hasExactAssetFilter: false,
    })).toEqual({ kind: 'reset' });
    // Without a prefix proof the offset is only upgraded, never primed.
    expect(resolveManifestCheckpointDecision({
      checkpoint: tokenless({ manifestPrefixDigest: undefined }),
      manifestDigest: MANIFEST_A,
      prefixDigestAtOffset: PREFIX,
      hasExactAssetFilter: false,
    })).toEqual({ kind: 'keep', prefixUpgrade: PREFIX });
  });

  it('never guesses a raw coordinate after the responder token is lost', () => {
    expect(resolveResponderResumeDecision({
      checkpoint: checkpoint({ responderSessionId: undefined }),
      usesPageSession: true,
      savedResponderSessionOffset: undefined,
      manifestCheckpointDecision: { kind: 'keep' },
    })).toEqual({ kind: 'reset-unmappable', verifiedOffset: 0, rawOffset: 0 });

    expect(resolveResponderResumeDecision({
      checkpoint: checkpoint({ responderSessionId: undefined }),
      usesPageSession: true,
      savedResponderSessionOffset: undefined,
      manifestCheckpointDecision: { kind: 'rebind-and-prime', prefixDigest: PREFIX },
    })).toEqual({ kind: 'prime', verifiedOffset: 512, rawOffset: 512 });

    expect(resolveResponderResumeDecision({
      checkpoint: tokenless(),
      usesPageSession: true,
      savedResponderSessionOffset: undefined,
      manifestCheckpointDecision: { kind: 'keep', primeable: true },
    })).toEqual({ kind: 'prime', verifiedOffset: 512, rawOffset: 512 });

    // A held token resumes its own raw coordinate; priming is only for a lost one.
    expect(resolveResponderResumeDecision({
      checkpoint: checkpoint(),
      usesPageSession: true,
      savedResponderSessionOffset: 512,
      manifestCheckpointDecision: { kind: 'keep', primeable: true },
    })).toEqual({ kind: 'resume', verifiedOffset: 512, rawOffset: 512 });
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


describe('one checkpoint resume plan', () => {
  it('binds a cross-generation candidate directly to current META without extending its lifetime', () => {
    const proposed = checkpoint({ offset: 1024 });
    const plan = resolveManifestResumePlan({ checkpoint: checkpoint(), proposedCheckpoint: proposed,
      manifestDigest: MANIFEST_B, prefixDigestAtOffset: () => PREFIX,
      hasExactAssetFilter: false, usesPageSession: true, savedResponderSessionOffset: 512, nowMs: 5000 });
    expect(plan.checkpointAction).toBe('replace');
    expect(plan.seeded).toBe(true);
    if (plan.checkpointAction !== 'replace') throw new Error('expected replacement');
    expect(plan.update).toEqual({ offset: 1024, manifestDigest: MANIFEST_B,
      manifestPrefixDigest: PREFIX, nowMs: proposed.updatedAtMs });
    expect(plan.resume).toEqual({ kind: 'prime', verifiedOffset: 1024, rawOffset: 1024 });
  });

  it('retains the destination checkpoint and live token when a proposed prefix is incompatible', () => {
    const destination = checkpoint();
    const plan = resolveManifestResumePlan({ checkpoint: destination,
      proposedCheckpoint: checkpoint({ offset: 1024, manifestDigest: MANIFEST_B, manifestPrefixDigest: OTHER_PREFIX }),
      manifestDigest: MANIFEST_A, prefixDigestAtOffset: () => PREFIX,
      hasExactAssetFilter: false, usesPageSession: true, savedResponderSessionOffset: 512, nowMs: 5000 });
    expect(plan.checkpointAction).toBe('keep');
    expect(plan.seeded).toBe(false);
    expect(plan).not.toHaveProperty('update');
    expect(plan.resume).toEqual({ kind: 'resume', verifiedOffset: 512, rawOffset: 512 });
  });
});


it('upgrades a legacy prefix without replacing its live raw responder coordinate', () => {
  const plan = resolveManifestResumePlan({ checkpoint: checkpoint({ manifestPrefixDigest: undefined, responderSessionOffset: 640 }),
    manifestDigest: MANIFEST_A, prefixDigestAtOffset: () => PREFIX,
    hasExactAssetFilter: false, usesPageSession: true, savedResponderSessionOffset: 640, nowMs: 5000 });
  expect(plan).toEqual({ checkpointAction: 'upgrade', seeded: false,
    update: { offset: 512, manifestDigest: MANIFEST_A, manifestPrefixDigest: PREFIX, nowMs: 5000 },
    resume: { kind: 'resume', verifiedOffset: 512, rawOffset: 640 } });
});

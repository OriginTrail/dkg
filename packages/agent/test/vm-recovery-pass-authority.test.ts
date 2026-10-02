/** The pass-local registered-authority observation: one typed state drives retry, wire choice and the log label. */
import { describe, expect, it } from 'vitest';
import {
  VM_RECOVERY_REGISTERED_PUBLIC_MAX_AGE_MS,
  VmRecoveryPassAuthority,
  type VmRecoveryPassAuthorityOwner,
} from '../src/vm-recovery-pass-authority.js';
import type { RegisteredContextGraphAuthority } from '../src/registered-context-graph-authority.js';

const publicAnswer: RegisteredContextGraphAuthority = { kind: 'public', onChainId: 1n };
const privateAnswer: RegisteredContextGraphAuthority = { kind: 'private', onChainId: 1n, participantAgents: [] };
const unavailableAnswer: RegisteredContextGraphAuthority = {
  kind: 'unavailable', onChainId: 1n, reason: 'chain-access-policy-unavailable',
};

function authorityWithClock() {
  let now = 1_000;
  return { authority: new VmRecoveryPassAuthority(() => now), advance: (ms: number) => { now += ms; } };
}

describe('VmRecoveryPassAuthority', () => {
  it('starts without an answer: not public, nothing to retry, labelled not-read', () => {
    const { authority } = authorityWithClock();
    expect(authority.observation).toEqual({ kind: 'not-read' });
    expect(authority.isPublic).toBe(false);
    expect(authority.missed).toBe(false);
    expect(authority.retryDue(0)).toBe(false);
    expect(authority.label).toBe('not-read');
  });

  it('treats only a public answer as authorization for the stream wire', async () => {
    const { authority } = authorityWithClock();
    await authority.read(async () => publicAnswer);
    expect(authority.isPublic).toBe(true);
    expect(authority.missed).toBe(false);
    expect(authority.label).toBe('public');
  });

  it('treats private and unregistered as answers, never as a transient miss', async () => {
    const { authority, advance } = authorityWithClock();
    for (const [answer, label] of [[privateAnswer, 'private'], [{ kind: 'unregistered' } as const, 'unregistered']] as const) {
      await authority.read(async () => answer);
      advance(60_000);
      expect(authority.isPublic).toBe(false);
      expect(authority.missed).toBe(false);
      expect(authority.retryDue(0)).toBe(false);
      expect(authority.label).toBe(label);
    }
  });

  it('records an unavailable answer as a miss, labelled with its reason', async () => {
    const { authority } = authorityWithClock();
    await authority.read(async () => unavailableAnswer);
    expect(authority.isPublic).toBe(false);
    expect(authority.missed).toBe(true);
    expect(authority.label).toBe('unavailable:chain-access-policy-unavailable');
  });

  it('records a read that throws as a miss instead of propagating it', async () => {
    const { authority } = authorityWithClock();
    await expect(authority.read(async () => { throw new Error('boom'); })).resolves.toEqual({ kind: 'read-failed' });
    expect(authority.missed).toBe(true);
    expect(authority.isPublic).toBe(false);
    expect(authority.label).toBe('error');
  });

  it('spaces retries from the start of the most recent read', async () => {
    const { authority, advance } = authorityWithClock();
    await authority.read(async () => unavailableAnswer);
    expect(authority.retryDue(5_000)).toBe(false);
    advance(4_999);
    expect(authority.retryDue(5_000)).toBe(false);
    advance(1);
    expect(authority.retryDue(5_000)).toBe(true);
    // A new read restarts the spacing.
    await authority.read(async () => unavailableAnswer);
    expect(authority.retryDue(5_000)).toBe(false);
  });

  it('lets a later answer supersede an earlier miss and stop the retries', async () => {
    const { authority, advance } = authorityWithClock();
    await authority.read(async () => unavailableAnswer);
    advance(10_000);
    expect(authority.retryDue(5_000)).toBe(true);
    await authority.read(async () => publicAnswer);
    advance(10_000);
    expect(authority.isPublic).toBe(true);
    expect(authority.retryDue(5_000)).toBe(false);
    // And an answer that regresses to a miss is a miss again.
    await authority.read(async () => unavailableAnswer);
    expect(authority.isPublic).toBe(false);
    expect(authority.missed).toBe(true);
  });
});

describe('registered-public evidence handed to the pass\'s own exchange', () => {
  const GRAPH = '0xabc/public-graph';

  /** A pass that has read a public answer, an owner whose state the test controls, and a clock. */
  async function ownedPass() {
    let now = 5_000;
    const authority = new VmRecoveryPassAuthority(() => now);
    await authority.read(async () => publicAnswer);
    const owner = { current: true, signal: new AbortController() };
    const ownerView: VmRecoveryPassAuthorityOwner = {
      contextGraphId: GRAPH, signal: owner.signal.signal,
      isCurrent: () => owner.current,
    };
    const evidence = authority.evidence(ownerView);
    return { authority, evidence, owner, advance: (ms: number) => { now += ms; } };
  }

  it('is usable right after the pass read a public answer, for that graph only', async () => {
    const { evidence } = await ownedPass();
    expect(evidence.usableFor(GRAPH)).toBe(true);
    expect(evidence.usableFor(GRAPH, new AbortController().signal)).toBe(true);
    expect(evidence.usableFor('0xabc/another-graph')).toBe(false);
  });

  it('is not usable before the pass has read anything, or after a read that did not say public', async () => {
    const early = authorityWithClock();
    const owner: VmRecoveryPassAuthorityOwner = { contextGraphId: GRAPH, isCurrent: () => true };
    const handle = early.authority.evidence(owner);
    expect(handle.usableFor(GRAPH)).toBe(false);
    for (const answer of [privateAnswer, unavailableAnswer, { kind: 'unregistered' } as const]) {
      await early.authority.read(async () => answer);
      expect(handle.usableFor(GRAPH)).toBe(false);
    }
    await early.authority.read(async () => { throw new Error('boom'); });
    expect(handle.usableFor(GRAPH)).toBe(false);
    // The same handle follows the pass: a later public answer makes it usable.
    await early.authority.read(async () => publicAnswer);
    expect(handle.usableFor(GRAPH)).toBe(true);
  });

  it('is withdrawn by a later read of the same pass that no longer says public', async () => {
    const { authority, evidence } = await ownedPass();
    expect(evidence.usableFor(GRAPH)).toBe(true);
    await authority.read(async () => unavailableAnswer);
    expect(evidence.usableFor(GRAPH)).toBe(false);
    await authority.read(async () => publicAnswer);
    expect(evidence.usableFor(GRAPH)).toBe(true);
    await authority.read(async () => privateAnswer);
    expect(evidence.usableFor(GRAPH)).toBe(false);
  });

  it('expires after the maximum age, measured from the read that produced it', async () => {
    const { authority, evidence, advance } = await ownedPass();
    advance(VM_RECOVERY_REGISTERED_PUBLIC_MAX_AGE_MS);
    expect(evidence.usableFor(GRAPH)).toBe(true);
    advance(1);
    expect(evidence.usableFor(GRAPH)).toBe(false);
    // A fresh public read of the same pass renews it.
    await authority.read(async () => publicAnswer);
    expect(evidence.usableFor(GRAPH)).toBe(true);
  });

  it('stops standing in when the operation loses ownership (checked after a usable answer, with live signals)', async () => {
    const { evidence, owner } = await ownedPass();
    expect(evidence.usableFor(GRAPH, new AbortController().signal)).toBe(true);
    owner.current = false;
    expect(owner.signal.signal.aborted).toBe(false);
    expect(evidence.usableFor(GRAPH, new AbortController().signal)).toBe(false);
  });

  it('treats a failing ownership probe as no ownership', async () => {
    const authority = new VmRecoveryPassAuthority(() => 0);
    await authority.read(async () => publicAnswer);
    let probeFails = false;
    const evidence = authority.evidence({
      contextGraphId: GRAPH,
      isCurrent: () => { if (probeFails) throw new Error('ownership probe failed'); return true; },
    });
    expect(evidence.usableFor(GRAPH)).toBe(true);
    probeFails = true;
    expect(evidence.usableFor(GRAPH)).toBe(false);
  });

  it('stops standing in when the owning operation is cancelled, independently of ownership', async () => {
    const { evidence, owner } = await ownedPass();
    expect(evidence.usableFor(GRAPH)).toBe(true);
    owner.signal.abort();
    expect(owner.current).toBe(true);
    expect(evidence.usableFor(GRAPH)).toBe(false);
  });

  it('refuses a cancelled asker without being used up for the others', async () => {
    const { evidence } = await ownedPass();
    const cancelled = new AbortController();
    expect(evidence.usableFor(GRAPH, cancelled.signal)).toBe(true);
    cancelled.abort();
    expect(evidence.usableFor(GRAPH, cancelled.signal)).toBe(false);
    // A refusal is not a deletion: a live asker still gets the answer.
    expect(evidence.usableFor(GRAPH, new AbortController().signal)).toBe(true);
  });

  it('dies when revoked, whatever the pass observed, and revoking one handle leaves another alone', async () => {
    const { authority, evidence } = await ownedPass();
    const other = authority.evidence({ contextGraphId: GRAPH, isCurrent: () => true });
    expect(evidence.usableFor(GRAPH)).toBe(true);
    expect(other.usableFor(GRAPH)).toBe(true);
    evidence.revoke();
    expect(authority.isPublic).toBe(true);
    expect(evidence.usableFor(GRAPH)).toBe(false);
    expect(other.usableFor(GRAPH)).toBe(true);
    // Revoking is final even after a renewing read.
    await authority.read(async () => publicAnswer);
    expect(evidence.usableFor(GRAPH)).toBe(false);
  });

  it('is not visible to anything that was not handed the handle', async () => {
    const { authority } = await ownedPass();
    // A different pass over the same graph has its own observation and no way to see this one.
    const independent = new VmRecoveryPassAuthority(() => 0);
    const handle = independent.evidence({ contextGraphId: GRAPH, isCurrent: () => true });
    expect(authority.isPublic).toBe(true);
    expect(handle.usableFor(GRAPH)).toBe(false);
  });
});

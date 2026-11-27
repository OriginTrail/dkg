// One presenter turns a batch publish into the outcome line, for the assertion list and
// the Verifiable Memory widget alike: success, a warning for a partial or unknown outcome,
// and a thrown failure.
import { describe, expect, it } from 'vitest';
import { publishOutcome } from '../src/ui/lib/publishOutcome.js';
import { outcomeUnknownPublishNote, partialPublishWarning, type BatchPublishResult } from '../src/ui/api.js';

const batch = (over: Partial<BatchPublishResult> = {}): BatchPublishResult => ({
  published: 0, total: 0, partial: 0, failures: [], ...over,
} as BatchPublishResult);

describe('publishOutcome', () => {
  it('is a success when everything published', () => {
    expect(publishOutcome(batch({ published: 2, total: 2 }))).toEqual({ tone: 'success', text: 'Published 2 knowledge assets to Verifiable Memory' });
    expect(publishOutcome(batch({ published: 1, total: 1 })).text).toBe('Published 1 knowledge asset to Verifiable Memory');
  });

  it('counts failures, with or without a noun, and stays a success', () => {
    const r = batch({ published: 1, total: 3, failures: [{ name: 'a', error: 'x' }, { name: 'b', error: 'y' }] as never });
    expect(publishOutcome(r)).toEqual({ tone: 'success', text: 'Published 1 knowledge asset to Verifiable Memory (2 could not be published)' });
    expect(publishOutcome(r, { failedNoun: 'assertion' }).text).toBe('Published 1 knowledge asset to Verifiable Memory (2 assertions could not be published)');
    const one = batch({ published: 1, total: 2, failures: [{ name: 'a', error: 'x' }] as never });
    expect(publishOutcome(one, { failedNoun: 'assertion' }).text).toContain('(1 assertion could not be published)');
  });

  it('warns when part of the batch only minted on-chain', () => {
    const r = batch({ published: 1, total: 2, partial: 1, partialError: 'bind failed' } as never);
    expect(publishOutcome(r)).toEqual({ tone: 'warning', text: `Published 1 knowledge asset to Verifiable Memory — 1: ${partialPublishWarning('bind failed')}` });
  });

  it('warns when an outcome is unknown, published or not', () => {
    const unknown = { outcomeUnknown: [{ name: 'u' }] } as never;
    const note = outcomeUnknownPublishNote(unknown)!;
    expect(publishOutcome(batch({ published: 1, total: 2, ...(unknown as object) }))).toEqual({ tone: 'warning', text: `Published 1 knowledge asset to Verifiable Memory — ${note}` });
    expect(publishOutcome(batch({ total: 1, ...(unknown as object) }))).toEqual({ tone: 'warning', text: note });
  });

  it('throws the first failure when nothing published', () => {
    expect(() => publishOutcome(batch({ total: 1, failures: [{ name: 'a', error: 'out of gas' }] as never }))).toThrow('a: out of gas');
    expect(() => publishOutcome(batch())).toThrow('Publish failed');
    const unknown = { outcomeUnknown: [{ name: 'u' }] } as never;
    expect(() => publishOutcome(batch({ total: 2, failures: [{ name: 'a', error: 'x' }] as never, ...(unknown as object) })))
      .toThrow(`a: x — ${outcomeUnknownPublishNote(unknown)}`);
  });
});

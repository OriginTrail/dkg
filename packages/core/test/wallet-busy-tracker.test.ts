import { describe, expect, it } from 'vitest';
import { WalletBusyTracker } from '../src/wallet-busy-tracker.js';

function tracker(wallets: string[], maxClosedPerWallet?: number): WalletBusyTracker {
  const t = new WalletBusyTracker(maxClosedPerWallet);
  t.setConfigured(wallets);
  return t;
}

describe('WalletBusyTracker', () => {
  it('knows nothing without configured wallets or observations', () => {
    expect(new WalletBusyTracker().classify(100)).toBe('unknown');
    expect(tracker(['a', 'b']).classify(100)).toBe('unknown');
    expect(tracker(['a']).configuredCount).toBe(1);
    const duplicates = tracker(['a', 'a', 'b']);
    expect(duplicates.configuredCount).toBe(2);
  });

  describe('two wallets', () => {
    // a: busy 100..200 and from 300 on. b: busy 150..250.
    function scenario(): WalletBusyTracker {
      const t = tracker(['a', 'b']);
      t.observe('a', false, 0);
      t.observe('b', false, 0);
      t.markBusy('a', 100);
      t.markBusy('b', 150);
      t.markFree('a', 200);
      t.markFree('b', 250);
      t.markBusy('a', 300);
      return t;
    }

    it.each([
      [50, 'free'], // both idle
      [120, 'free'], // a busy, b idle
      [160, 'busy'], // both busy
      [220, 'free'], // a idle again
      [260, 'free'], // both idle
      [350, 'free'], // a busy, b idle
    ] as const)('classifies t=%d as %s', (at, expected) => {
      expect(scenario().classify(at)).toBe(expected);
    });

    it('is busy only while every wallet holds a lock', () => {
      const t = scenario();
      t.markBusy('b', 400);
      expect(t.classify(450)).toBe('busy');
    });
  });

  it('does not count the lock of the claiming wallet against the job it just claimed', () => {
    const t = tracker(['a']);
    t.observe('a', false, 0);
    // The job became ready at 100 and the claim wrote the lock at the same instant.
    t.markBusy('a', 100);
    expect(t.classify(100)).toBe('free');
    expect(t.classify(101)).toBe('busy');
  });

  it('treats the instant a lock was freed as free and the instant before as busy', () => {
    const t = tracker(['a']);
    t.observe('a', false, 0);
    t.markBusy('a', 100);
    t.markFree('a', 200);
    expect(t.classify(199)).toBe('busy');
    expect(t.classify(200)).toBe('free');
  });

  it('does not reopen an interval when a held lock is refreshed', () => {
    const t = tracker(['a']);
    t.observe('a', false, 0);
    t.markBusy('a', 100);
    t.markBusy('a', 150); // a heartbeat rewrite of the same lock
    t.markFree('a', 200);
    t.markFree('a', 210); // a second delete finds nothing open
    expect(t.classify(125)).toBe('busy');
    expect(t.classify(205)).toBe('free');
  });

  it('is unknown for a wallet it has not seen and for an instant before it first saw one', () => {
    const t = tracker(['a', 'b']);
    t.observe('a', false, 500);
    // b was never seen: a is free, so the job is free regardless.
    expect(t.classify(600)).toBe('free');
    // Before a was first seen nothing is known about either wallet.
    expect(t.classify(400)).toBe('unknown');
    // a busy and b unseen: cannot say busy.
    t.markBusy('a', 700);
    expect(t.classify(800)).toBe('unknown');
  });

  describe('after a restart', () => {
    it('seeds a held lock at the first read, so earlier instants are unknown and later ones busy', () => {
      const t = tracker(['a']);
      t.observe('a', true, 1_000);
      expect(t.classify(900)).toBe('unknown');
      expect(t.classify(1_100)).toBe('busy');
      t.observe('a', true, 1_200); // read again: no second interval
      t.markFree('a', 1_300);
      expect(t.classify(1_250)).toBe('busy');
      expect(t.classify(1_400)).toBe('free');
    });

    it('sees an expired lock as free', () => {
      const t = tracker(['a']);
      t.markBusy('a', 100);
      t.observe('a', false, 400); // the lock expired and was never swept
      expect(t.classify(300)).toBe('busy');
      expect(t.classify(500)).toBe('free');
    });

    it('marks a known wallet busy from the read that found its lock, not from its first sighting', () => {
      const t = tracker(['a']);
      t.markFree('a', 10); // first sighting long before the read
      t.observe('a', true, 1_000); // a lock written outside this process's write path
      expect(t.classify(500)).toBe('free');
      expect(t.classify(1_100)).toBe('busy');
    });

    it('learns a wallet is free from a delete it did not see the write of', () => {
      const t = tracker(['a']);
      t.markFree('a', 100);
      expect(t.classify(50)).toBe('unknown');
      expect(t.classify(150)).toBe('free');
    });
  });

  it('keeps a bounded history and calls an instant older than the oldest kept interval unknown', () => {
    const t = tracker(['a'], 2);
    t.observe('a', false, 0);
    for (const [start, end] of [[10, 20], [30, 40], [50, 60]] as const) {
      t.markBusy('a', start);
      t.markFree('a', end);
    }
    // [10,20] was dropped: its busy time is no longer known, so it is not reported free.
    expect(t.classify(15)).toBe('unknown');
    expect(t.classify(35)).toBe('busy');
    expect(t.classify(55)).toBe('busy');
    expect(t.classify(45)).toBe('free');
  });
});

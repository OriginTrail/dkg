import { describe, it, expect } from 'vitest';
import {
  awaitTailWithGrace,
  resolvePublishTailGraceMs,
  DEFAULT_PUBLISH_TAIL_GRACE_MS,
} from '../src/publish-tail-grace.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('awaitTailWithGrace (GH #1572)', () => {
  it('returns "completed" when the tail settles inside the grace, without firing the detach callback', async () => {
    let detached = 0;
    const outcome = await awaitTailWithGrace(1_000, sleep(20), () => { detached += 1; });
    expect(outcome).toBe('completed');
    // give any stray callback a chance to fire before asserting
    await sleep(50);
    expect(detached).toBe(0);
  });

  it('rethrows a tail failure that happens inside the grace (plain-await parity)', async () => {
    let detached = 0;
    const failing = (async () => { await sleep(10); throw new Error('store exploded'); })();
    await expect(awaitTailWithGrace(1_000, failing, () => { detached += 1; })).rejects.toThrow('store exploded');
    await sleep(50);
    expect(detached).toBe(0);
  });

  it('returns "detached" promptly when the tail outlives the grace, and the tail still completes', async () => {
    let tailDone = false;
    let detachedError: unknown = 'not-called';
    const tail = (async () => { await sleep(300); tailDone = true; })();
    const started = Date.now();
    const outcome = await awaitTailWithGrace(50, tail, (err) => { detachedError = err; });
    const waited = Date.now() - started;
    expect(outcome).toBe('detached');
    expect(waited).toBeLessThan(250); // responded at ~graceMs, not at tail completion
    expect(tailDone).toBe(false);     // tail genuinely still running at detach time
    await sleep(400);
    expect(tailDone).toBe(true);      // ...and it ran to completion afterwards
    expect(detachedError).toBeUndefined(); // settled-ok callback fired with no error
  });

  it('routes a post-grace tail failure into the callback instead of an unhandled rejection', async () => {
    let detachedError: unknown;
    const tail = (async () => { await sleep(150); throw new Error('late failure'); })();
    const outcome = await awaitTailWithGrace(20, tail, (err) => { detachedError = err; });
    expect(outcome).toBe('detached');
    await sleep(300);
    expect(detachedError).toBeInstanceOf(Error);
    expect((detachedError as Error).message).toBe('late failure');
  });

  it('graceMs=0 detaches immediately for a pending tail', async () => {
    let tailDone = false;
    const tail = (async () => { await sleep(100); tailDone = true; })();
    const outcome = await awaitTailWithGrace(0, tail, () => {});
    expect(outcome).toBe('detached');
    expect(tailDone).toBe(false);
    await sleep(200);
    expect(tailDone).toBe(true);
  });
});

describe('resolvePublishTailGraceMs', () => {
  it('defaults when unset, empty, or invalid; honors valid values including 0', () => {
    expect(resolvePublishTailGraceMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_PUBLISH_TAIL_GRACE_MS);
    expect(resolvePublishTailGraceMs({ DKG_PUBLISH_TAIL_GRACE_MS: '' } as NodeJS.ProcessEnv)).toBe(DEFAULT_PUBLISH_TAIL_GRACE_MS);
    expect(resolvePublishTailGraceMs({ DKG_PUBLISH_TAIL_GRACE_MS: 'soon' } as NodeJS.ProcessEnv)).toBe(DEFAULT_PUBLISH_TAIL_GRACE_MS);
    expect(resolvePublishTailGraceMs({ DKG_PUBLISH_TAIL_GRACE_MS: '-5' } as NodeJS.ProcessEnv)).toBe(DEFAULT_PUBLISH_TAIL_GRACE_MS);
    expect(resolvePublishTailGraceMs({ DKG_PUBLISH_TAIL_GRACE_MS: '0' } as NodeJS.ProcessEnv)).toBe(0);
    expect(resolvePublishTailGraceMs({ DKG_PUBLISH_TAIL_GRACE_MS: '12000' } as NodeJS.ProcessEnv)).toBe(12_000);
    expect(resolvePublishTailGraceMs({ DKG_PUBLISH_TAIL_GRACE_MS: '2500.9' } as NodeJS.ProcessEnv)).toBe(2_500);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { backfillVmPublishIntentIndexOnBoot } from '../src/daemon/vm-publish-intent-backfill.js';

// #1828 — daemon-boot wiring for the intent-index backfill. The engine test
// (packages/publisher) covers ensureVmPublishIntentIndex itself; this locks the
// boot-side contract that runDaemonInner depends on: the backfill is invoked,
// its count is surfaced, and — critically — a thrown error is swallowed so a
// backfill hiccup can never abort daemon boot.
describe('#1828 backfillVmPublishIntentIndexOnBoot', () => {
  it('invokes ensureVmPublishIntentIndex once and logs the count when > 0', async () => {
    const ensureVmPublishIntentIndex = vi.fn().mockResolvedValue(3);
    const logs: string[] = [];
    await backfillVmPublishIntentIndexOnBoot({ ensureVmPublishIntentIndex }, (m) => logs.push(m));
    expect(ensureVmPublishIntentIndex).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['Publisher: backfilled intent-recovery index for 3 job(s)']);
  });

  it('invokes the backfill but stays quiet when there is nothing to index', async () => {
    const ensureVmPublishIntentIndex = vi.fn().mockResolvedValue(0);
    const logs: string[] = [];
    await backfillVmPublishIntentIndexOnBoot({ ensureVmPublishIntentIndex }, (m) => logs.push(m));
    expect(ensureVmPublishIntentIndex).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([]);
  });

  it('is fail-open: a backfill error is logged and swallowed, never thrown', async () => {
    const ensureVmPublishIntentIndex = vi.fn().mockRejectedValue(new Error('store offline'));
    const logs: string[] = [];
    await expect(
      backfillVmPublishIntentIndexOnBoot({ ensureVmPublishIntentIndex }, (m) => logs.push(m)),
    ).resolves.toBeUndefined();
    expect(ensureVmPublishIntentIndex).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['Publisher: intent-index backfill skipped (store offline)']);
  });
});

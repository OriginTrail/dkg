import { describe, expect, it } from 'vitest';
import { formatPeerStatusTooltip } from '../src/ui/lib/formatPeerStatus.js';

/**
 * The status pill in the global header now exposes a multiline tooltip
 * (BUG-020) that breaks down peers into direct/relayed and surfaces
 * uptime so operators don't have to jump into Settings to diagnose
 * sync issues. The helper is pure — these tests pin the exact shape so
 * a copy regression (e.g. "0 peers (0 direct, 0 relayed)" silently
 * becoming "0 peer (0 direct, 0 relayed)") is caught.
 */
describe('formatPeerStatusTooltip (BUG-020)', () => {
  it('reports the synced + plural peer counts with both connection breakdowns', () => {
    const out = formatPeerStatusTooltip(true, 12, 7, 5, 2 * 86_400_000);
    const lines = out.split('\n');
    expect(lines).toEqual([
      'Synced with the network',
      '12 peers (7 direct, 5 relayed)',
      'Uptime 2d 0h 0m',
    ]);
  });

  it('reports "Syncing" when synced=false', () => {
    const out = formatPeerStatusTooltip(false, 0, 0, 0, 0);
    expect(out).toMatch(/^Syncing with the network/);
  });

  it('singularises "1 peer" (no trailing s) and keeps the parenthetical breakdown plural-agnostic', () => {
    const out = formatPeerStatusTooltip(true, 1, 1, 0, 0);
    expect(out).toContain('1 peer (1 direct, 0 relayed)');
    expect(out).not.toContain('1 peers');
  });

  it('uses "peers" for 0 (zero is plural in English)', () => {
    const out = formatPeerStatusTooltip(true, 0, 0, 0, 0);
    expect(out).toContain('0 peers (0 direct, 0 relayed)');
  });

  it('omits the Uptime line when uptimeMs is 0 (avoids "Uptime 0m" noise on cold start)', () => {
    const out = formatPeerStatusTooltip(true, 5, 3, 2, 0);
    expect(out).not.toContain('Uptime');
    expect(out.split('\n')).toHaveLength(2);
  });

  it('emits "Xh Ym" for sub-day uptime, omitting the days component', () => {
    const fiveHoursMs = (5 * 3600 + 23 * 60) * 1000;
    const out = formatPeerStatusTooltip(true, 1, 1, 0, fiveHoursMs);
    expect(out).toContain('Uptime 5h 23m');
    expect(out).not.toContain('0d');
  });

  it('emits "Xm" only when uptime is < 1h (clean tooltip for fresh nodes)', () => {
    const out = formatPeerStatusTooltip(true, 1, 1, 0, 4 * 60 * 1000);
    expect(out).toContain('Uptime 4m');
    expect(out).not.toContain('0h');
  });

  it('always includes the minutes component, even at 0m on the day boundary', () => {
    const exactlyOneDay = 86_400_000;
    const out = formatPeerStatusTooltip(true, 1, 1, 0, exactlyOneDay);
    expect(out).toContain('Uptime 1d 0h 0m');
  });

  it('clamps negative uptime values to zero rather than reporting nonsense (defensive)', () => {
    const out = formatPeerStatusTooltip(true, 1, 1, 0, -1);
    // A negative value should have skipped the `if (uptimeMs > 0)`
    // guard so no Uptime line is rendered. This pins the contract:
    // the helper never invents a positive uptime from a clock skew.
    expect(out).not.toContain('Uptime');
  });

  it('newline-separates the lines so the browser tooltip renders them on separate rows', () => {
    const out = formatPeerStatusTooltip(true, 1, 1, 0, 1000);
    // The `\n` splitter is the contract — Chrome's `title=` attribute
    // wraps on `\n` by default but not on `\r` or `<br>`.
    expect(out).toContain('\n');
    expect(out).not.toContain('<br>');
    expect(out).not.toContain('\r');
  });
});

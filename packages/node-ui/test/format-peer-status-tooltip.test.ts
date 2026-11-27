import { describe, expect, it } from 'vitest';
import { formatPeerStatusTooltip, headerNodeStatus } from '../src/ui/lib/formatPeerStatus.js';
import { NODE_UNAVAILABLE_AFTER_FAILURES, isNodeStatusFailure } from '../src/ui/lib/nodeStatusPolicy.js';
import { useAgentsStore } from '../src/ui/stores/agents.js';

/**
 * The peer count in the global header exposes a multiline tooltip
 * (BUG-020) that breaks down peers into direct/relayed and surfaces
 * uptime so operators don't have to jump into Settings to inspect
 * connectivity. The helper is pure — these tests pin the exact shape so
 * a copy regression (e.g. "0 peers (0 direct, 0 relayed)" silently
 * becoming "0 peer (0 direct, 0 relayed)") is caught.
 */
describe('headerNodeStatus', () => {
  it('says Connecting, neutral, before any status has loaded', () => {
    expect(headerNodeStatus(false, 0, 0)).toMatchObject({ word: 'Connecting', tone: 'pending', showPeers: false });
  });

  it('is green with the peer count only when the node has peers', () => {
    expect(headerNodeStatus(true, 12, 0)).toMatchObject({ word: 'Connected', tone: 'success', showPeers: true });
    expect(headerNodeStatus(true, 0, 0)).toMatchObject({ word: 'No peers', tone: 'warning', showPeers: false });
  });

  it('keeps the last state until enough checks fail in a row, then says Unavailable', () => {
    const limit = NODE_UNAVAILABLE_AFTER_FAILURES;
    expect(headerNodeStatus(true, 12, limit - 1).word).toBe('Connected');
    expect(headerNodeStatus(true, 12, limit)).toMatchObject({ word: 'Unavailable', tone: 'danger', showPeers: false });
    expect(headerNodeStatus(false, 0, limit).word).toBe('Unavailable');
  });

  it('gives Connecting and Unavailable their own tooltip, so old peer data never shows', () => {
    expect(headerNodeStatus(false, 0, 0).tooltip).toBe('Connecting to the node');
    expect(headerNodeStatus(true, 12, NODE_UNAVAILABLE_AFTER_FAILURES).tooltip).toBe('The node is not responding. Checking again every 10 seconds.');
    expect(headerNodeStatus(true, 12, 0).tooltip).toBeUndefined();
  });
});

describe('isNodeStatusFailure', () => {
  it('counts network errors and server errors, but not a 401 from a running node', () => {
    expect(isNodeStatusFailure(new Error('Request timed out after 10s'))).toBe(true);
    expect(isNodeStatusFailure({ status: 503 })).toBe(true);
    expect(isNodeStatusFailure({ status: 401 })).toBe(false);
  });
});

describe('node status failure count', () => {
  it('adds up failed checks and clears on a good status', () => {
    const store = useAgentsStore.getState();
    store.setNodeStatus({ connectedPeers: 2 });
    store.recordNodeStatusFailure();
    store.recordNodeStatusFailure();
    expect(useAgentsStore.getState().nodeStatusFailures).toBe(2);
    store.setNodeStatus({ connectedPeers: 2 });
    expect(useAgentsStore.getState().nodeStatusFailures).toBe(0);
  });

  // A 401 clearing the count is checked through the real poll in node-status-polling.dom.test.ts.
});

describe('formatPeerStatusTooltip (BUG-020)', () => {
  it('reports the connected + plural peer counts with both connection breakdowns', () => {
    const out = formatPeerStatusTooltip(12, 7, 5, 2 * 86_400_000);
    const lines = out.split('\n');
    expect(lines).toEqual([
      'Connected to the network',
      '12 peers (7 direct, 5 relayed)',
      'Uptime 2d 0h 0m',
    ]);
  });

  it('says no peers are connected when there are none', () => {
    expect(formatPeerStatusTooltip(0, 0, 0, 0)).toBe('No peers connected');
  });

  it('singularises "1 peer" (no trailing s) and keeps the parenthetical breakdown plural-agnostic', () => {
    const out = formatPeerStatusTooltip(1, 1, 0, 0);
    expect(out).toContain('1 peer (1 direct, 0 relayed)');
    expect(out).not.toContain('1 peers');
  });

  it('keeps the uptime but drops the empty breakdown when there are no peers', () => {
    expect(formatPeerStatusTooltip(0, 0, 0, 4 * 60 * 1000).split('\n')).toEqual(['No peers connected', 'Uptime 4m']);
  });

  it('omits the Uptime line when uptimeMs is 0 (avoids "Uptime 0m" noise on cold start)', () => {
    const out = formatPeerStatusTooltip(5, 3, 2, 0);
    expect(out).not.toContain('Uptime');
    expect(out.split('\n')).toHaveLength(2);
  });

  it('emits "Xh Ym" for sub-day uptime, omitting the days component', () => {
    const fiveHoursMs = (5 * 3600 + 23 * 60) * 1000;
    const out = formatPeerStatusTooltip(1, 1, 0, fiveHoursMs);
    expect(out).toContain('Uptime 5h 23m');
    expect(out).not.toContain('0d');
  });

  it('emits "Xm" only when uptime is < 1h (clean tooltip for fresh nodes)', () => {
    const out = formatPeerStatusTooltip(1, 1, 0, 4 * 60 * 1000);
    expect(out).toContain('Uptime 4m');
    expect(out).not.toContain('0h');
  });

  it('always includes the minutes component, even at 0m on the day boundary', () => {
    const exactlyOneDay = 86_400_000;
    const out = formatPeerStatusTooltip(1, 1, 0, exactlyOneDay);
    expect(out).toContain('Uptime 1d 0h 0m');
  });

  it('clamps negative uptime values to zero rather than reporting nonsense (defensive)', () => {
    const out = formatPeerStatusTooltip(1, 1, 0, -1);
    // A negative value should have skipped the `if (uptimeMs > 0)`
    // guard so no Uptime line is rendered. This pins the contract:
    // the helper never invents a positive uptime from a clock skew.
    expect(out).not.toContain('Uptime');
  });

  it('newline-separates the lines so the browser tooltip renders them on separate rows', () => {
    const out = formatPeerStatusTooltip(1, 1, 0, 1000);
    // The `\n` splitter is the contract — Chrome's `title=` attribute
    // wraps on `\n` by default but not on `\r` or `<br>`.
    expect(out).toContain('\n');
    expect(out).not.toContain('<br>');
    expect(out).not.toContain('\r');
  });
});

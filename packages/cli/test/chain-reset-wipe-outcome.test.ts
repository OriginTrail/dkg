import { describe, expect, it } from 'vitest';
import {
  formatChainResetWipeOutcome,
  type ChainResetWipeResult,
} from '../src/daemon/chain-reset-wipe.js';

const NEW_MARKER = 'v10-rs-staking-consolidation-2026-04-30';
const OLD_MARKER = 'v9-mainnet-launch-2025-12-01';

describe('formatChainResetWipeOutcome', () => {
  const effects = {
    prevMarker: OLD_MARKER,
    removedFiles: ['store.nq.tmp'],
    backedUpFiles: ['store.nq.pre-wipe-old'],
  };

  it.each([
    {
      status: 'completed', attempted: true, requiresStoreRetag: false,
      ...effects, failedFiles: [],
    },
    {
      status: 'incomplete', attempted: true, requiresStoreRetag: true,
      ...effects, failedFiles: [{ file: 'publish-journal.blocked', error: 'is a directory' }],
    },
    {
      status: 'marker-write-failed', attempted: true, requiresStoreRetag: true,
      ...effects, failedFiles: [], markerError: 'state path is a directory',
    },
  ] satisfies ChainResetWipeResult[])('formats the $status reset result', (result) => {
    const messages = formatChainResetWipeOutcome(result, NEW_MARKER);
    expect(messages[0]).toContain(`Chain-state auto-wipe ${
      result.status === 'completed' ? 'complete' : result.status
    }:`);
    expect(messages[0]).toContain(`prev marker: ${OLD_MARKER}, now: ${NEW_MARKER}`);
    expect(messages).toHaveLength(result.status === 'completed' ? 1 : 2);
    if (result.status === 'incomplete') {
      expect(messages[1]).toContain('1 wipe target(s) failed');
    } else if (result.status === 'marker-write-failed') {
      expect(messages[1]).toContain('state path is a directory');
    }
  });

  it('stays silent when no wipe was attempted', () => {
    expect(formatChainResetWipeOutcome({
      status: 'steady', attempted: false, requiresStoreRetag: false,
      prevMarker: NEW_MARKER, removedFiles: [], backedUpFiles: [], failedFiles: [],
    }, NEW_MARKER)).toEqual([]);
  });
});

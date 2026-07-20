import { describe, expect, it, vi } from 'vitest';
import type { WalRetentionSemanticCoreV1 } from '@origintrail-official/dkg-wal/retention';
import {
  DkgSemanticCore,
  type DkgSemanticCoreTraceEvent,
} from '../src/semantic/dkg-semantic-core.js';
import { DkgWalRetentionSemanticAdapterV1 } from '../src/wal/retention-semantic-adapter.js';

describe('DkgWalRetentionSemanticAdapterV1', () => {
  it('routes delete and snapshot validation through one shared DKG semantic core', async () => {
    const events: DkgSemanticCoreTraceEvent[] = [];
    const semanticCore = new DkgSemanticCore({ observer: event => events.push(event) });
    const implementation: WalRetentionSemanticCoreV1 = {
      authorizeDelete: vi.fn(async () => ({ status: 'accepted', evidence: { kind: 'owner' } })),
      validateSnapshotEntry: vi.fn(async () => true),
      validateSnapshotConflict: vi.fn(async () => true),
    };
    const bridge = new DkgWalRetentionSemanticAdapterV1({
      implementation,
      driver: 'wal-sync',
      semanticCore,
    });
    await bridge.authorizeDelete({} as never);
    await bridge.validateSnapshotEntry({} as never);
    await bridge.validateSnapshotConflict({} as never);
    expect(events.filter(event => event.phase === 'enter').map(event => event.entryPoint)).toEqual([
      'wal-delete-expiry-authorization',
      'wal-snapshot-baseline-entry-validation',
      'wal-snapshot-baseline-conflict-validation',
    ]);
    expect(implementation.authorizeDelete).toHaveBeenCalledOnce();
    expect(implementation.validateSnapshotEntry).toHaveBeenCalledOnce();
    expect(implementation.validateSnapshotConflict).toHaveBeenCalledOnce();
  });
});

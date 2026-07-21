import { describe, expect, it, vi } from 'vitest';
import type { WalMigrationSemanticCoreV1 } from '@origintrail-official/dkg-wal';
import {
  DkgSemanticCore,
  type DkgSemanticCoreTraceEvent,
} from '../src/semantic/dkg-semantic-core.js';
import { createDkgWalMigrationSemanticAdapterV1 } from '../src/wal/genesis-migration-adapter.js';

describe('WAL-018 DKG migration semantic boundary', () => {
  it('forwards LegacyGenesisV1 policy decisions through the one semantic core', async () => {
    const traces: DkgSemanticCoreTraceEvent[] = [];
    const implementation: WalMigrationSemanticCoreV1 = {
      authorizeLegacyGenesis: vi.fn(async () => ({
        status: 'quarantined' as const,
        reasonCode: 'explicit-policy-required',
      })),
    };
    const adapter = createDkgWalMigrationSemanticAdapterV1({
      implementation,
      driver: 'wal-sync',
      semanticCore: new DkgSemanticCore({ observer: event => traces.push(event) }),
    });
    const input = {
      object: [] as never,
      legacyGenesis: [] as never,
      migrationPolicyObjectId: new Uint8Array(32),
      barrierVectorId: new Uint8Array(32),
    };
    await expect(adapter.authorizeLegacyGenesis(input)).resolves.toEqual({
      status: 'quarantined',
      reasonCode: 'explicit-policy-required',
    });
    expect(implementation.authorizeLegacyGenesis).toHaveBeenCalledWith(input);
    expect(traces).toEqual([
      { driver: 'wal-sync', entryPoint: 'wal-legacy-genesis-authorization', phase: 'enter' },
      { driver: 'wal-sync', entryPoint: 'wal-legacy-genesis-authorization', phase: 'return' },
    ]);
  });

  it('preserves throws and legacy-sync trace context without alternate behavior', async () => {
    const traces: DkgSemanticCoreTraceEvent[] = [];
    const failure = new Error('migration policy unavailable');
    const adapter = createDkgWalMigrationSemanticAdapterV1({
      implementation: { authorizeLegacyGenesis: vi.fn(async () => { throw failure; }) },
      driver: 'legacy-sync',
      semanticCore: new DkgSemanticCore({ observer: event => traces.push(event) }),
    });
    await expect(adapter.authorizeLegacyGenesis({
      object: [] as never,
      legacyGenesis: [] as never,
      migrationPolicyObjectId: new Uint8Array(32),
      barrierVectorId: new Uint8Array(32),
    })).rejects.toBe(failure);
    expect(traces).toEqual([
      { driver: 'legacy-sync', entryPoint: 'wal-legacy-genesis-authorization', phase: 'enter' },
      { driver: 'legacy-sync', entryPoint: 'wal-legacy-genesis-authorization', phase: 'throw' },
    ]);
  });
});

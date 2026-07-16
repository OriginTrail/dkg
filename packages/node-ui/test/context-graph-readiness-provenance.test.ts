import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB } from '../src/db.js';

describe('DashboardDB context-graph readiness provenance', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('survives a database restart and is removed with the subscription', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dkg-cg-readiness-'));
    directories.push(dataDir);
    const contextGraphId = 'owner/private-cg';

    const first = new DashboardDB({ dataDir });
    first.upsertContextGraphSubscription({
      context_graph_id: contextGraphId,
      name: 'Private CG',
      subscribed: 1,
      synced: 1,
      shared_memory_synced: 0,
      meta_synced: 1,
      on_chain_id: null,
      on_chain_hash: null,
      last_reconciled_ordinal: null,
      core_hosted: 0,
      sync_scoped: 1,
      updated_at: Date.now(),
    });
    first.setContextGraphReadinessProvenance(contextGraphId, {
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: false,
      updatedAt: 1234,
    });
    first.close();

    const second = new DashboardDB({ dataDir });
    expect(second.getContextGraphReadinessProvenance(contextGraphId)).toEqual({
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: false,
      updatedAt: 1234,
    });

    second.deleteContextGraphSubscription(contextGraphId);
    expect(second.getContextGraphReadinessProvenance(contextGraphId)).toBeNull();
    second.close();
  });
});

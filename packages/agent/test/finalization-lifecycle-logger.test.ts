import { afterEach, describe, expect, it } from 'vitest';
import { Logger, type LogRecord } from '@origintrail-official/dkg-core';
import {
  FinalizationLifecycleLogger,
  finalizationLifecycleDecision,
} from '../src/finalization-lifecycle-logger.js';

describe('FinalizationLifecycleLogger', () => {
  afterEach(() => {
    Logger.setSink(null);
  });

  it('normalizes finalization decisions into receiver lifecycle logs', () => {
    const entries: LogRecord[] = [];
    Logger.setSink((entry) => entries.push(entry));
    const lifecycle = new FinalizationLifecycleLogger(new Logger('FinalizationLifecycleLoggerTest'), {
      localPeerId: 'receiver-peer',
      localNodeIdentityId: 42n,
    });

    lifecycle.record({ operationId: 'op-finalization', operationName: 'gossip' }, finalizationLifecycleDecision(
      'finalization_no_data',
      {
        ual: 'did:dkg:evm:31337/0xasset/7',
        contextGraphId: '42',
        targetContextGraphId: '42',
        txHash: '0xabc',
        publisherAddress: '0xpublisher',
        blockNumber: 100n,
        batchId: 7n,
        rootEntityCount: 1,
        swmStatementCount: 0,
        outcome: 'deferred',
        retryable: true,
        reason: 'no shared memory data',
        level: 'warn',
      },
    ));

    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('warn');
    expect(entries[0].message).toContain('ka_publish_lifecycle');
    expect(entries[0].message).toContain('assetUal=did:dkg:evm:31337/0xasset/7');
    expect(entries[0].message).toContain('stage=finalization');
    expect(entries[0].message).toContain('event=finalization_no_data');
    expect(entries[0].message).toContain('role=receiver');
    expect(entries[0].message).toContain('localPeerId=receiver-peer');
    expect(entries[0].message).toContain('localNodeIdentityId=42');
    expect(entries[0].message).toContain('outcome=deferred');
    expect(entries[0].message).toContain('retryable=true');
    expect(entries[0].message).toContain('reason="no shared memory data"');
  });
});

import { describe, expect, it } from 'vitest';
import {
  mapPublishExceptionToLiftJobFailure,
  mapPublishResultToLiftJobSuccess,
} from '../src/async-lift-publish-result.js';

describe('async lift publish result mapping', () => {
  it('maps tentative canonical publish into included LiftJob state', () => {
    const mapped = mapPublishResultToLiftJobSuccess({
      walletId: 'wallet-1',
      publicByteSize: 123,
      publishResult: {
        kaId: 1n,
        ual: 'did:dkg:mock:31337/0xabc/1',
        merkleRoot: new Uint8Array([0xab, 0xcd]),
        kaManifest: [],
        status: 'tentative',
        onChainResult: {
          batchId: 7n,
          startKAId: 1n,
          endKAId: 1n,
          txHash: '0xabc',
          blockNumber: 10,
          blockTimestamp: 1700000000,
          publisherAddress: '0x1111111111111111111111111111111111111111',
        },
      },
    });

    expect(mapped.status).toBe('included');
    expect(mapped.broadcast.txHash).toBe('0xabc');
    expect(mapped.broadcast.walletId).toBe('wallet-1');
    expect(mapped.broadcast.merkleRoot).toBe('0xabcd');
    expect(mapped.broadcast.publicByteSize).toBe(123);
    expect(mapped.inclusion.txHash).toBe('0xabc');
    expect(mapped.inclusion.blockNumber).toBe(10);
    expect(mapped.inclusion.blockTimestamp).toBe(1700000000);
    expect(mapped.finalization).toBeUndefined();
  });

  it('maps confirmed canonical publish into finalized LiftJob state', () => {
    const mapped = mapPublishResultToLiftJobSuccess({
      walletId: 'wallet-1',
      publishResult: {
        kaId: 1n,
        ual: 'did:dkg:mock:31337/0xabc/1',
        merkleRoot: new Uint8Array([0xab, 0xcd]),
        kaManifest: [],
        status: 'confirmed',
        onChainResult: {
          batchId: 7n,
          startKAId: 1n,
          endKAId: 1n,
          txHash: '0xabc',
          blockNumber: 10,
          blockTimestamp: 1700000000,
          publisherAddress: '0x1111111111111111111111111111111111111111',
        },
      },
    });

    expect(mapped.status).toBe('finalized');
    expect(mapped.finalization?.ual).toBe('did:dkg:mock:31337/0xabc/1');
    expect(mapped.finalization?.batchId).toBe('7');
    expect(mapped.finalization?.startKAId).toBe('1');
    expect(mapped.finalization?.endKAId).toBe('1');
    expect(mapped.finalization?.publisherAddress).toBe('0x1111111111111111111111111111111111111111');
  });

  it('maps tentative canonical publish without chain details into local finalized LiftJob state', () => {
    const mapped = mapPublishResultToLiftJobSuccess({
      walletId: 'wallet-1',
      publishResult: {
        kaId: 0n,
        ual: 'did:dkg:mock:31337/0xabc/t1',
        merkleRoot: new Uint8Array([0xab, 0xcd]),
        kaManifest: [],
        status: 'tentative',
      },
    });

    expect(mapped.status).toBe('finalized');
    expect(mapped.broadcast).toBeUndefined();
    expect(mapped.inclusion).toBeUndefined();
    expect(mapped.finalization).toEqual({
      mode: 'local',
      ual: 'did:dkg:mock:31337/0xabc/t1',
    });
  });

  it('rejects failed canonical publish results in the success mapper', () => {
    expect(() =>
      mapPublishResultToLiftJobSuccess({
        walletId: 'wallet-1',
        publishResult: {
          kaId: 1n,
          ual: 'did:dkg:mock:31337/0xabc/1',
          merkleRoot: new Uint8Array([0xab, 0xcd]),
          kaManifest: [],
          status: 'failed',
          onChainResult: {
            batchId: 7n,
            txHash: '0xabc',
            blockNumber: 10,
            blockTimestamp: 1700000000,
            publisherAddress: '0x1111111111111111111111111111111111111111',
          },
        },
      }),
    ).toThrow('Async lift publish result cannot map failed canonical publish into success state');
  });

  it('classifies submit timeout exceptions as retryable broadcast failures', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error('RPC submit timed out after 30s'),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:submit-timeout',
      timeout: {
        timeoutMs: 30_000,
        timeoutAt: 123,
        handling: 'check_chain_then_finalize_or_reset',
      },
    });

    expect(failure.code).toBe('tx_submit_timeout');
    expect(failure.phase).toBe('broadcast');
    expect(failure.retryable).toBe(true);
    expect(failure.timeout).toEqual({
      timeoutMs: 30_000,
      timeoutAt: 123,
      handling: 'check_chain_then_finalize_or_reset',
    });
  });

  it('classifies confirmation mismatches on included jobs', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error('confirmation mismatch detected'),
      failedFromState: 'included',
      errorPayloadRef: 'urn:error:confirmation-mismatch',
    });

    expect(failure.code).toBe('confirmation_mismatch');
    expect(failure.phase).toBe('confirmation');
    expect(failure.retryable).toBe(false);
  });

  it('falls back to a terminal confirmation failure for unknown included-phase errors', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error('unexpected included-phase issue'),
      failedFromState: 'included',
      errorPayloadRef: 'urn:error:unknown-included',
    });

    expect(failure.code).toBe('confirmation_mismatch');
    expect(failure.phase).toBe('confirmation');
    expect(failure.retryable).toBe(false);
  });

  it('classifies a private-no-acks broadcast failure as TERMINAL, not retryable (Codex #1132 / GH #1013/#1121)', () => {
    // Before the fix this generic broadcast-phase failure fell through to
    // `rpc_unavailable` (retryable) and the queue retried forever a publish
    // that can never reach VM until encrypted private async publish (#1121).
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error(
        'Async publish to a chain-registered context graph could not reach Verifiable Memory: ' +
        'private payload had no collectable storage ACKs (peers cannot see private data).',
      ),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:private-no-acks',
    });

    expect(failure.code).toBe('private_unanchorable');
    expect(failure.mode).toBe('terminal');
    expect(failure.retryable).toBe(false);
  });
});

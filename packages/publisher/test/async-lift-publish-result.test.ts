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
        kcId: 1n,
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
        kcId: 1n,
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

  it('rejects publish results that never reached canonical on-chain submission', () => {
    expect(() =>
      mapPublishResultToLiftJobSuccess({
        walletId: 'wallet-1',
        publishResult: {
          kcId: 1n,
          ual: 'did:dkg:mock:31337/0xabc/1',
          merkleRoot: new Uint8Array([0xab, 0xcd]),
          kaManifest: [],
          status: 'tentative',
        },
      }),
    ).toThrow('Async lift publish result requires onChainResult to produce LiftJob state');
  });

  it('rejects failed canonical publish results in the success mapper', () => {
    expect(() =>
      mapPublishResultToLiftJobSuccess({
        walletId: 'wallet-1',
        publishResult: {
          kcId: 1n,
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

  it('refuses to guess unknown included-phase failures', () => {
    expect(() =>
      mapPublishExceptionToLiftJobFailure({
        error: new Error('unexpected included-phase issue'),
        failedFromState: 'included',
        errorPayloadRef: 'urn:error:unknown-included',
      }),
    ).toThrow('Unable to classify included publish exception');
  });
});

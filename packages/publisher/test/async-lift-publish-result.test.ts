import { describe, expect, it } from 'vitest';
import {
  mapPublishExceptionToLiftJobFailure,
  mapPublishResultToLiftJobSuccess,
} from '../src/async-lift-publish-result.js';
import { QuorumUnmetError } from '../src/ack-errors.js';

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

  it('classifies typed ACK quorum failures separately from RPC outages', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new QuorumUnmetError({ collected: 2, required: 3, dialled: 2 }),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:quorum-unmet',
    });

    expect(failure.code).toBe('quorum_unmet');
    expect(failure.retryable).toBe(true);
    expect(failure.resolution).toBe('reset_to_accepted');
  });

  it('recognizes a rewrapped quorum failure from its legacy message', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error('QuorumUnmetError(collected=0/3, dialled=0)'),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:rewrapped-quorum-unmet',
    });

    expect(failure.code).toBe('quorum_unmet');
    expect(failure.retryable).toBe(true);
    expect(failure.resolution).toBe('reset_to_accepted');
  });

  it('drops submit-timeout metadata from a quorum failure with legacy timeout text', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new QuorumUnmetError({
        collected: 2,
        required: 3,
        dialled: 3,
        legacyMessage: 'storage_ack_timeout: only 2/3 ACKs received',
      }),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:quorum-timeout',
      timeout: {
        timeoutMs: 30_000,
        timeoutAt: 123,
        handling: 'check_chain_then_finalize_or_reset',
      },
    });

    expect(failure.code).toBe('quorum_unmet');
    expect(failure.retryable).toBe(true);
    expect(failure.timeout).toBeUndefined();
  });

  it('classifies a NO_FUNDED_PUBLISHER_WALLET error as a TERMINAL insufficient_funds failure (not retryable)', () => {
    // The funded-wallet-selection error message intentionally does NOT contain
    // the literal "insufficient funds" substring; without code-based
    // recognition it would fall through to the retryable rpc_unavailable
    // default and retry an unfundable job forever.
    const err = Object.assign(
      new Error('No operational wallet has enough funds to publish to Verifiable Memory — fund a wallet and retry.'),
      { code: 'NO_FUNDED_PUBLISHER_WALLET' },
    );
    const failure = mapPublishExceptionToLiftJobFailure({
      error: err,
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:no-funded-wallet',
    });

    expect(failure.code).toBe('insufficient_funds');
    expect(failure.retryable).toBe(false);
  });

  it('classifies PUBLISH_AUTHOR_NOT_CUSTODIAL as a TERMINAL authority_forbidden failure (not retryable)', () => {
    // GH#1786: the async worker discovers mid-publish that it cannot re-sign this author's
    // UpdateAuthorAttestation. That is PERMANENT — before this mapping it fell through to the
    // retryable rpc_unavailable default and the queue reset a job that can never finalize,
    // the same forever-retry trap #1013/#1121 fixed for unfundable publishes.
    const err = Object.assign(
      new Error(
        'cannot re-sign UpdateAuthorAttestation for author 0xA32f1cc125401B55911678847426759094055B2d — '
        + 'no custodial key on file and it is not the publisher EOA.',
      ),
      { code: 'PUBLISH_AUTHOR_NOT_CUSTODIAL' },
    );
    const failure = mapPublishExceptionToLiftJobFailure({
      error: err,
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:author-not-custodial',
    });

    expect(failure.code).toBe('authority_forbidden');
    expect(failure.retryable).toBe(false);
    expect(failure.resolution).toBe('fail_job');
    // `phase` is persisted and returned by the job APIs, so it must not contradict
    // `failedFromState`: this code is also reachable from claimed/validated, where the
    // phase IS 'validation'. A fixed policy phase would report this broadcast-time
    // failure as validation to anyone filtering by phase.
    expect(failure.phase).toBe('broadcast');
  });

  it('classifies a code-stripped non-custodial author error (message marker only) as terminal', () => {
    // Same robustness as the funds path below: a re-wrap can drop .code but keep the message.
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error(
        'publishFromFinalizedAssertion (update path): cannot re-sign UpdateAuthorAttestation for author 0xabc — '
        + 'no custodial key on file and it is not the publisher EOA.',
      ),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:author-not-custodial-nocode',
    });

    expect(failure.code).toBe('authority_forbidden');
    expect(failure.retryable).toBe(false);
    expect(failure.phase).toBe('broadcast');
  });

  it('classifies a code-stripped funds error (message marker only) as terminal insufficient_funds from broadcast', () => {
    // A re-wrap could drop .code but preserve the message — the marker fallback
    // must still keep it terminal (mirrors the daemon + node-ui robustness).
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error('No operational wallet has enough funds to publish to Verifiable Memory — fund a wallet and retry.'),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:no-funded-wallet-msg',
    });

    expect(failure.code).toBe('insufficient_funds');
    expect(failure.retryable).toBe(false);
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

});

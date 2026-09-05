// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { StoreOperationTimeoutError, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import {
  createPromotePostCommitFailure,
  createPromoteRetryableFailure,
} from '@origintrail-official/dkg-publisher';
import { classifyExactSwmGraphReplaceFailure } from '../../publisher/test/_helpers/promote-replay-safety.js';
import {
  classifyPromoteError,
  diagnosticPromoteStage,
  safePromoteErrorIdentity,
} from '../src/daemon/worker/async-promote-error-classification.js';

const PROMOTE_RETRYABLE_FAILURE_CODE = 'PROMOTE_RETRYABLE_FAILURE';

describe('diagnosticPromoteStage', () => {
  it.each([
    'ensureSubGraphRegistered',
    'assertGraphScopedLifecycleWritable',
    'knowledgeAssetPrivateQuads',
    'assertionScopedQuads',
    'assertTrustedCatalogTriplesAllowed',
    'encodeWorkspaceGossipPayload',
  ])('retains the producer-owned %s stage without its message', (stage) => {
    expect(diagnosticPromoteStage(`[promote:${stage}] opaque secret-sentinel failure`)).toBe(stage);
  });

  it.each([
    '[promote:callerControlled] opaque secret-sentinel failure',
    '[promote:] failure',
    'prefix [promote:assertionScopedQuads] failure',
    'untagged failure',
  ])('maps an unowned or absent stage to unknown: %s', (message) => {
    expect(diagnosticPromoteStage(message)).toBe('unknown');
  });
});

describe('safePromoteErrorIdentity', () => {
  it('preserves only producer-owned error name and code', () => {
    const error = { name: 'CuratorRejectedError', code: 'CURATOR_REJECTED' };
    expect(safePromoteErrorIdentity(error, 'name')).toBe('CuratorRejectedError');
    expect(safePromoteErrorIdentity(error, 'code')).toBe('CURATOR_REJECTED');
  });

  it('omits caller-controlled identities even when they look like identifiers', () => {
    const alphanumericSecretToken = 'AKIAIOSFODNN7EXAMPLE';
    const failure = Object.assign(new Error('opaque secret-sentinel failure'), {
      name: `Error${alphanumericSecretToken}`,
      code: alphanumericSecretToken,
    });
    expect(safePromoteErrorIdentity(failure, 'name')).toBeUndefined();
    expect(safePromoteErrorIdentity(failure, 'code')).toBeUndefined();
  });

  it.each([undefined, null, 'Error', 42, {}, { name: 1, code: false }])(
    'omits missing or non-string identities: %s', (error) => {
      expect(safePromoteErrorIdentity(error, 'name')).toBeUndefined();
      expect(safePromoteErrorIdentity(error, 'code')).toBeUndefined();
    },
  );

  it('contains property access failures', () => {
    const failure = {
      get name() { throw new Error('unsafe getter'); },
      get code() { throw new Error('unsafe getter'); },
    };
    expect(safePromoteErrorIdentity(failure, 'name')).toBeUndefined();
    expect(safePromoteErrorIdentity(failure, 'code')).toBeUndefined();
  });
});

describe('classifyPromoteError', () => {
  // RFC §10 / plan §10.3 — the three patterns surfaced by the rc.10 Graphify import
  // (`INTEGRATION_NOTES_GRAPHIFY.md`), plus the fatal default.

  it('classifies gossip-cap errors as cap_exceeded (non-retryable)', () => {
    const verdict = classifyPromoteError(
      new Error('Promoted assertion too large for gossip (5120 KB, limit 4 MB). Promote fewer entities per call.'),
    );
    expect(verdict).toEqual({ classification: 'cap_exceeded', retryable: false });
  });

  it('classifies typed SWM gossip-cap errors by code', () => {
    const err = new Error('custom wording') as Error & { code: string };
    err.code = 'SWM_GOSSIP_PAYLOAD_TOO_LARGE';

    const verdict = classifyPromoteError(err);

    expect(verdict).toEqual({ classification: 'cap_exceeded', retryable: false });
  });

  it('classifies 256 KB body-cap errors as cap_exceeded', () => {
    const verdict = classifyPromoteError(new Error('Request body too large (>262144 bytes)'));
    expect(verdict.classification).toBe('cap_exceeded');
    expect(verdict.retryable).toBe(false);
  });

  it('classifies generic PayloadTooLargeError as cap_exceeded', () => {
    const verdict = classifyPromoteError(new Error('payload too large for this endpoint'));
    expect(verdict.classification).toBe('cap_exceeded');
  });

  it('classifies fetch failures as transient (retryable)', () => {
    expect(classifyPromoteError(new Error('fetch failed'))).toEqual({
      classification: 'transient',
      retryable: true,
    });
    expect(classifyPromoteError(new Error('ECONNRESET reading socket'))).toEqual({
      classification: 'transient',
      retryable: true,
    });
    expect(classifyPromoteError(new Error('socket hang up'))).toEqual({
      classification: 'transient',
      retryable: true,
    });
  });

  // #1464 — the publisher tags a promote error's message with a "[promote:<step>] " prefix so the
  // failing step is NAMED. The step LABEL must never change the retry classification: the classifier
  // strips the tag before substring-matching. Regression for the gate-caught collision where the
  // step label "encodeWorkspaceGossipPayload" injected the "gossip" trigger token, flipping a
  // transient error to non-retryable cap_exceeded. Fails without the tag-strip.
  it('#1464 — strips the [promote:<step>] tag before classifying (label tokens do not change the verdict)', () => {
    // A transient error tagged at the gossip-encode step (label contains "gossip") stays retryable.
    expect(classifyPromoteError(new Error('[promote:encodeWorkspaceGossipPayload] rate limit exceeded — request timed out')))
      .toEqual({ classification: 'transient', retryable: true });
    // Identical to the same error untagged.
    expect(classifyPromoteError(new Error('rate limit exceeded — request timed out')))
      .toEqual({ classification: 'transient', retryable: true });
    // A GENUINE gossip-cap error (token in the ORIGINAL message) still classifies cap_exceeded even
    // when tagged — stripping removes only the injected prefix, never real tokens.
    expect(classifyPromoteError(new Error('[promote:assertionScopedQuads] Promoted assertion too large for gossip (limit 4 MB)')))
      .toEqual({ classification: 'cap_exceeded', retryable: false });
  });

  it('classifies timeout errors as transient', () => {
    expect(classifyPromoteError(new Error('Operation timed out'))).toEqual({
      classification: 'transient',
      retryable: true,
    });
    expect(classifyPromoteError(new Error('ETIMEDOUT connecting to 127.0.0.1'))).toEqual({
      classification: 'transient',
      retryable: true,
    });
  });

  it('retries a publisher-owned generic promote failure', () => {
    expect(classifyPromoteError(createPromoteRetryableFailure(
      new Error('domain failure hidden behind the promote boundary'),
    ))).toEqual({
      classification: 'transient',
      retryable: true,
      publisherDiagnostic: {
        name: 'PromoteRetryableFailureError',
        code: PROMOTE_RETRYABLE_FAILURE_CODE,
      },
    });
  });

  it('keeps post-commit failures terminal even when their cause is retryable', () => {
    expect(classifyPromoteError(createPromotePostCommitFailure(
      createPromoteRetryableFailure(new Error('observer failed')),
    ))).toEqual({
      classification: 'fatal',
      retryable: false,
      publisherDiagnostic: {
        name: 'PromotePostCommitFailureError',
        code: 'PROMOTE_POST_COMMIT_FAILURE',
      },
    });
  });

  it('recognizes a serialized generic retry marker without relying on class identity', () => {
    expect(classifyPromoteError({
      code: PROMOTE_RETRYABLE_FAILURE_CODE,
    })).toEqual({
      classification: 'transient',
      retryable: true,
      publisherDiagnostic: {
        name: 'PromoteRetryableFailureError',
        code: PROMOTE_RETRYABLE_FAILURE_CODE,
      },
    });
    expect(classifyPromoteError({
      code: `${PROMOTE_RETRYABLE_FAILURE_CODE}_LOOKALIKE`,
    })).toEqual({ classification: 'fatal', retryable: false });
    expect(classifyPromoteError({
      code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
    })).toEqual({ classification: 'fatal', retryable: false });
  });

  it('does not retry an authoritative empty signing roster', () => {
    expect(classifyPromoteError(
      new Error('authoritative signing roster is empty'),
    )).toEqual({ classification: 'fatal', retryable: false });
  });

  it('requires typed outcomes for managed-store and scheduler failures', () => {
    for (const message of [
      'STORE_OPERATION_TIMEOUT Managed Oxigraph is recovering; query was not started',
      'Managed Oxigraph recovery interrupted query execution',
      'Managed Oxigraph recovery interrupted listGraphs; outcome is indeterminate',
      'Managed Oxigraph recovery interrupted countQuads; outcome is indeterminate',
      'Store scheduler queue wait timeout',
    ]) {
      expect(classifyPromoteError(new Error(message))).toEqual({
        classification: 'fatal',
        retryable: false,
      });
    }
    expect(classifyPromoteError(new StoreSchedulerBusyError(
      'queue_wait_timeout', 'normal', 'publisher.asyncPromote.write',
      { storeOperation: 'replaceSubject' },
    ))).toEqual({
      classification: 'transient',
      retryable: true,
    });
  });

  it('retries typed indeterminate reads and producer-certified replay while failing closed for raw writes', () => {
    for (const operation of [
      'query',
      'construct',
      'hasGraph',
      'listGraphs',
      'listGraphsByPrefix',
      'countQuads',
    ] as const) {
      expect(classifyPromoteError(new StoreOperationTimeoutError({
        backend: 'oxigraph-server',
        operation,
        outcome: 'indeterminate',
      }))).toEqual({ classification: 'transient', retryable: true });
    }

    const rawReplaceFailure = new StoreOperationTimeoutError({
      backend: 'oxigraph-server',
      operation: 'replaceGraph',
      outcome: 'indeterminate',
      message: 'Managed Oxigraph recovery interrupted replaceGraph; outcome is indeterminate',
    });
    expect(classifyPromoteError(rawReplaceFailure)).toEqual({
      classification: 'fatal',
      retryable: false,
    });
    expect(classifyPromoteError(
      classifyExactSwmGraphReplaceFailure(rawReplaceFailure),
    )).toEqual({
      classification: 'transient',
      retryable: true,
      publisherDiagnostic: {
        name: 'PromoteReplaySafeError',
        code: 'PROMOTE_REPLAY_SAFE_FAILURE',
      },
    });
    expect(classifyPromoteError(classifyExactSwmGraphReplaceFailure(
      new StoreOperationTimeoutError({
        backend: 'oxigraph-server',
        operation: 'replaceGraph',
        outcome: 'indeterminate',
        message: 'payload too large while reading the indeterminate timeout response',
      }),
    ))).toEqual({
      classification: 'transient',
      retryable: true,
      publisherDiagnostic: {
        name: 'PromoteReplaySafeError',
        code: 'PROMOTE_REPLAY_SAFE_FAILURE',
      },
    });
    expect(classifyPromoteError({
      code: 'PROMOTE_REPLAY_SAFE_FAILURE',
      stage: 'atomic-exact-swm-graph-replacement',
      cause: rawReplaceFailure,
    })).toEqual({ classification: 'fatal', retryable: false });
    for (const malformed of [
      { code: 'PROMOTE_REPLAY_SAFE_FAILURE', cause: rawReplaceFailure },
      {
        code: 'PROMOTE_REPLAY_SAFE_FAILURE',
        stage: 'other',
        cause: rawReplaceFailure,
      },
      {
        code: 'PROMOTE_REPLAY_SAFE_FAILURE',
        stage: 'atomic-exact-swm-graph-replacment',
        cause: rawReplaceFailure,
      },
      {
        code: 'PROMOTE_REPLAY_SAFE_FAILURE',
        stage: 'atomic-exact-swm-graph-replacement',
      },
    ]) {
      expect(classifyPromoteError(malformed)).toEqual({
        classification: 'fatal',
        retryable: false,
      });
    }

    for (const message of [
      'insert timed out',
      'insert timeout after dispatch',
    ]) {
      expect(classifyPromoteError(new StoreOperationTimeoutError({
        backend: 'oxigraph-server',
        operation: 'insert',
        outcome: 'indeterminate',
        message,
      }))).toEqual({ classification: 'fatal', retryable: false });
    }
  });

  it('classifies unknown errors as fatal (non-retryable)', () => {
    expect(classifyPromoteError(new Error('assertion not found: foo'))).toEqual({
      classification: 'fatal',
      retryable: false,
    });
    expect(classifyPromoteError(new Error('something exploded'))).toEqual({
      classification: 'fatal',
      retryable: false,
    });
  });

  it('handles non-Error throws (strings, undefined)', () => {
    expect(classifyPromoteError('boom').classification).toBe('fatal');
    expect(classifyPromoteError(undefined).classification).toBe('fatal');
  });
});

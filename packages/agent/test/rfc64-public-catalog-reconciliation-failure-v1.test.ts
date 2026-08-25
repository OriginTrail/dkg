import type { Digest32V1 } from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';

import { Rfc64PublicCatalogNativeReceiverErrorV1 } from '../src/rfc64/public-catalog-native-receiver-v1.js';
import { FinalizedVmCompositionErrorV1 } from '../src/rfc64/finalized-vm-composer-v1.js';
import {
  RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_MAX_ENTRIES_V1,
  Rfc64PublicCatalogReconciliationFailureRegistryV1,
  classifyRfc64CatalogReconciliationTerminalReasonV1,
} from '../src/rfc64/public-catalog-reconciliation-failure-v1.js';

function digest(index: number): Digest32V1 {
  return `0x${index.toString(16).padStart(64, '0')}` as Digest32V1;
}

describe('RFC-64 public catalog terminal failure registry v1', () => {
  it('retains immutable typed identities with deterministic oldest-first eviction', () => {
    const registry = new Rfc64PublicCatalogReconciliationFailureRegistryV1();
    const terminalError = new Rfc64PublicCatalogNativeReceiverErrorV1(
      'catalog-native-receiver-authorization',
      'nondeterministic message text is deliberately excluded',
    );
    for (
      let index = 1;
      index <= RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_MAX_ENTRIES_V1 + 1;
      index += 1
    ) {
      registry.record(digest(index), terminalError);
    }

    expect(registry.size).toBe(
      RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_MAX_ENTRIES_V1,
    );
    expect(registry.read(digest(1))).toBeNull();
    const retained = registry.read(digest(2));
    expect(retained).toEqual({
      catalogHeadDigest: digest(2),
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-authorization',
    });
    expect(Object.isFrozen(retained)).toBe(true);

    registry.record(digest(2), Object.assign(new Error('later'), { code: 'later-code' }));
    expect(registry.read(digest(2))).toEqual(retained);
  });

  it('normalizes unstable identities and clears all process-local state', () => {
    const registry = new Rfc64PublicCatalogReconciliationFailureRegistryV1();
    const malformed = Object.assign(new Error('contains /tmp/random/path'), {
      name: 'invalid name with spaces',
      code: `x${'!'.repeat(128)}`,
    });
    registry.record(digest(1), malformed);
    expect(registry.read(digest(1))).toEqual({
      catalogHeadDigest: digest(1),
      errorName: 'UnknownError',
      errorCode: null,
    });

    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.read(digest(1))).toBeNull();
  });

  it('retains one stable typed cause code without retaining cause text', () => {
    const registry = new Rfc64PublicCatalogReconciliationFailureRegistryV1();
    const cause = Object.assign(new Error('private asset details stay local'), {
      code: 'finalized-vm-composition-incomplete',
    });
    registry.record(digest(1), new Rfc64PublicCatalogNativeReceiverErrorV1(
      'catalog-native-receiver-activation',
      'precommit failed',
      { cause },
    ));

    expect(registry.read(digest(1))).toEqual({
      catalogHeadDigest: digest(1),
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-activation',
      causeCode: 'finalized-vm-composition-incomplete',
    });
  });

  it('keeps immutable diagnostics separate from the current retry result', () => {
    const registry = new Rfc64PublicCatalogReconciliationFailureRegistryV1();
    const head = digest(1);
    const firstAttempt = registry.beginAttempt(head);
    registry.record(
      head,
      Object.assign(new Error('first'), { code: 'first-code' }),
      null,
      firstAttempt,
    );
    expect(registry.readCurrentAttempt(head)).toMatchObject({ errorCode: 'first-code' });

    const secondAttempt = registry.beginAttempt(head);
    expect(registry.readCurrentAttempt(head)).toBeNull();
    registry.record(
      head,
      Object.assign(new Error('second'), { code: 'second-code' }),
      null,
      secondAttempt,
    );

    expect(registry.read(head)).toMatchObject({ errorCode: 'first-code' });
    expect(registry.readCurrentAttempt(head)).toMatchObject({
      terminalReason: null,
      errorCode: 'second-code',
    });
  });

  it('fences stale failure and success callbacks by monotonic attempt token', () => {
    const registry = new Rfc64PublicCatalogReconciliationFailureRegistryV1();
    const head = digest(1);
    const older = registry.beginAttempt(head);
    const newer = registry.beginAttempt(head);
    expect(newer).toBeGreaterThan(older);

    registry.record(
      head,
      Object.assign(new Error('older failure'), { code: 'older-code' }),
      null,
      older,
    );
    expect(registry.readCurrentAttempt(head)).toBeNull();

    registry.record(
      head,
      Object.assign(new Error('newer failure'), { code: 'newer-code' }),
      null,
      newer,
    );
    expect(registry.readCurrentAttempt(head)).toMatchObject({ errorCode: 'newer-code' });
    registry.completeAttempt(head, older);
    expect(registry.readCurrentAttempt(head)).toMatchObject({ errorCode: 'newer-code' });
    registry.completeAttempt(head, newer);
    expect(registry.readCurrentAttempt(head)).toBeNull();
  });

  it('translates only the exact typed private VM incomplete failure', () => {
    const incomplete = new FinalizedVmCompositionErrorV1(
      'finalized-vm-composition-incomplete',
      'private details are not part of the semantic result',
    );
    const wrapped = new Rfc64PublicCatalogNativeReceiverErrorV1(
      'catalog-native-receiver-activation',
      'precommit failed',
      { cause: incomplete },
    );
    expect(classifyRfc64CatalogReconciliationTerminalReasonV1(wrapped))
      .toBe('no-authorized-provider');
    expect(classifyRfc64CatalogReconciliationTerminalReasonV1(
      new Rfc64PublicCatalogNativeReceiverErrorV1(
        'catalog-native-receiver-activation',
        'ordinary failure',
        { cause: new Error('RPC unavailable') },
      ),
    )).toBeNull();
  });
});

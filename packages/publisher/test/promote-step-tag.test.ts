/**
 * Issue #1464 (PR1, diagnostic) — the WM→SWM promote pre-insert step tagging.
 *
 * Two levels:
 *   A. `tagPromoteStep` / `tagPromoteError` unit tests — pin the labelling
 *      semantics (in-place tag, identity/`code`/stack preservation, idempotency,
 *      read-only-message wrap, non-object wrap).
 *   B. One integration through the real `assertionPromote`: fault-inject a
 *      rejection into the first pre-insert store read and assert the caller sees
 *      a `[promote:<step>]`-tagged error instead of an anonymous transport throw.
 *
 * No Hardhat / no HTTP: the integration builds a publisher over an in-memory
 * store whose `query` is stubbed to reject, so it is deterministic and
 * Windows-runnable.
 */

import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  isPromoteStepName,
  PROMOTE_STEP_NAMES,
  tagPromoteError,
  tagPromoteStep,
} from '../src/promote-step-tag.js';
import { DKGPublisher } from '../src/dkg-publisher.js';

describe('#1464 promote step tagging — isPromoteStepName', () => {
  // The guard is the producer-owned narrowing the CLI classifies against
  // (`diagnosticPromoteStage`), so the publisher owns its coverage rather than
  // leaning on the consumer's suite to exercise it.
  //
  // Deriving the accept cases from the tuple IS true by construction — but here
  // that is the contract: the guard and the tuple are the same declaration in
  // the same file, and "member of PROMOTE_STEP_NAMES" is all the predicate
  // claims. A hand-written copy would duplicate the tuple with no second owner
  // to disagree with it. (Contrast the CLI stage test, which spans an ownership
  // boundary and therefore does keep an independent literal.) The assertions
  // that can actually fail are the rejections below.
  it.each(PROMOTE_STEP_NAMES)('accepts the producer-owned %s stage', (stage) => {
    expect(isPromoteStepName(stage)).toBe(true);
  });

  it.each([
    'resolveKaNumber', // a plausible-looking step that is NOT in the tuple
    'wmGraphUri',
    'callerControlled',
    'ensureSubGraphRegistered ', // trailing space — no trimming
    'EnsureSubGraphRegistered', // case-sensitive
    '',
  ])('rejects the unowned value %o', (value) => {
    expect(isPromoteStepName(value)).toBe(false);
  });
});

describe('#1464 promote step tagging — tagPromoteStep / tagPromoteError', () => {
  it('passes a resolved value through unchanged', async () => {
    await expect(tagPromoteStep('assertionScopedQuads', async () => 42)).resolves.toBe(42);
  });

  it('tags a rejected plain Error IN PLACE, preserving object identity, code, and stack', async () => {
    const original = new Error('SPARQL HTTP query failed (500): boom');
    (original as { code?: unknown }).code = 'RPC_503';
    const originalStack = original.stack; // materialise before tagging

    let caught: unknown;
    await tagPromoteStep('assertionScopedQuads', async () => {
      throw original;
    }).catch((e) => {
      caught = e;
    });

    expect(caught).toBe(original); // same object — instanceof / typed class preserved
    expect((caught as Error).message).toBe(
      '[promote:assertionScopedQuads] SPARQL HTTP query failed (500): boom',
    );
    expect((caught as { code?: unknown }).code).toBe('RPC_503'); // PR2 classification signal survives
    expect((caught as Error).stack).toBe(originalStack); // stack untouched
  });

  it('never double-prefixes — the innermost promote step wins', () => {
    const already = new Error('[promote:assertionScopedQuads] deep failure');
    const tagged = tagPromoteError('knowledgeAssetPrivateQuads', already);
    expect(tagged).toBe(already);
    expect((tagged as Error).message).toBe('[promote:assertionScopedQuads] deep failure');
  });

  it('handles a read-only-message error (DOMException from AbortSignal.timeout) without throwing', () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const tagged = tagPromoteError('assertionScopedQuads', timeout) as Error & {
      cause?: unknown;
      code?: unknown;
    };

    expect(tagged.message).toBe('[promote:assertionScopedQuads] The operation timed out.');
    expect(tagged.name).toBe('TimeoutError'); // transient signal preserved
    // Robust to either strategy: mutated-in-place (same object) OR wrapped-with-cause.
    expect(tagged === timeout || tagged.cause === timeout).toBe(true);
  });

  it('wraps a non-object throwable (string) in a tagged Error', () => {
    const tagged = tagPromoteError('ensureSubGraphRegistered', 'raw string failure') as Error;
    expect(tagged).toBeInstanceOf(Error);
    expect(tagged.message).toBe('[promote:ensureSubGraphRegistered] raw string failure');
  });
});

describe('#1464 promote step tagging — assertionPromote integration', () => {
  it('surfaces a [promote:<step>] tag when a pre-insert store read rejects', async () => {
    const store = new OxigraphStore();
    const boom = new Error('SPARQL HTTP query failed (500): oxigraph worker unavailable');
    (boom as { code?: unknown }).code = 'OXIGRAPH_DOWN';
    // The graph-scoped lifecycle write gate is the first pre-insert store read.
    store.query = async () => {
      throw boom;
    };

    const publisher = new DKGPublisher({
      store,
      chain: {} as unknown as ChainAdapter, // unused before the reject point
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });

    await expect(
      publisher.assertionPromote(
        'cg-1464',
        'my-assertion',
        '0x1234567890abcdef1234567890abcdef12345678',
      ),
    ).rejects.toThrow(/^\[promote:assertGraphScopedLifecycleWritable\] SPARQL HTTP query failed \(500\)/);

    // Original error identity + classification code preserved for PR2.
    expect(boom.message).toContain('[promote:assertGraphScopedLifecycleWritable]');
    expect((boom as { code?: unknown }).code).toBe('OXIGRAPH_DOWN');
  });
});

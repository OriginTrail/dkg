/**
 * GH#2940 — the typed boundary for a rejected pre-send write-ahead hook.
 *
 * The adapter used to re-throw a rejected hook as a bare `new Error(message)`, discarding the
 * hook's own error. `ChainWriteAheadHookError` keeps the message byte-for-byte and carries the
 * original as `cause`; consumers unwrap `cause` ONLY from this wrapper. These rows pin the guard
 * and the two mock-adapter write-ahead sites (the EVM adapter site is pinned next to the existing
 * fail-closed row in evm-adapter-nonce-serialization.unit.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { MockChainAdapter } from '../src/mock-adapter.js';
import {
  CHAIN_WRITE_AHEAD_HOOK_FAILED_CODE,
  ChainWriteAheadHookError,
  getChainWriteAheadHookCause,
  isChainWriteAheadHookError,
} from '../src/write-ahead-hook-error.js';

const SIGNER = '0x1111111111111111111111111111111111111111';

describe('ChainWriteAheadHookError', () => {
  it('keeps the message and carries the hook error as cause', () => {
    const hook = new Error('WAL disk full');
    const wrapped = new ChainWriteAheadHookError('chain:writeahead hook failed before publish broadcast: WAL disk full', hook);

    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.name).toBe('ChainWriteAheadHookError');
    expect(wrapped.code).toBe(CHAIN_WRITE_AHEAD_HOOK_FAILED_CODE);
    expect(wrapped.message).toBe('chain:writeahead hook failed before publish broadcast: WAL disk full');
    expect(wrapped.cause).toBe(hook);
    expect(getChainWriteAheadHookCause(wrapped)).toBe(hook);
  });

  it('is recognised structurally on its namespaced code, so it survives a bundle boundary', () => {
    const crossBundle = Object.assign(new Error('copied'), {
      code: 'CHAIN_WRITE_AHEAD_HOOK_FAILED',
      cause: 'the hook error',
    });
    expect(isChainWriteAheadHookError(crossBundle)).toBe(true);
    expect(getChainWriteAheadHookCause(crossBundle)).toBe('the hook error');
  });

  it.each([
    ['a plain Error', new Error('nope')],
    ['an error with a generic code', Object.assign(new Error('x'), { code: 'TIMEOUT' })],
    ['a non-object', 'chain:writeahead hook failed'],
    ['null', null],
    ['undefined', undefined],
  ])('does not recognise %s', (_label, value) => {
    expect(isChainWriteAheadHookError(value)).toBe(false);
    expect(getChainWriteAheadHookCause(value)).toBeUndefined();
  });

  it('never unwraps the cause of an error that is not the wrapper', () => {
    // An unrelated error that merely carries a cause must not be read as a write-ahead failure.
    const unrelated = new Error('some other failure', { cause: new Error('hidden') });
    expect(getChainWriteAheadHookCause(unrelated)).toBeUndefined();
  });

  it('does not throw out of a classification read on a hostile accessor', () => {
    const hostileCode = Object.defineProperty({}, 'code', { get() { throw new Error('boom'); } });
    expect(isChainWriteAheadHookError(hostileCode)).toBe(false);

    const hostileCause = Object.defineProperty(
      Object.assign(new Error('x'), { code: 'CHAIN_WRITE_AHEAD_HOOK_FAILED' }),
      'cause',
      { get() { throw new Error('boom'); } },
    );
    expect(isChainWriteAheadHookError(hostileCause)).toBe(true);
    expect(getChainWriteAheadHookCause(hostileCause)).toBeUndefined();
  });
});

describe('MockChainAdapter write-ahead hook failures', () => {
  it('re-throws a rejected createKnowledgeAssets hook as the wrapper, message unchanged', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const hookError = new Error('WAL disk full');

    const thrown = await mock.createKnowledgeAssets({
      ackSignatures: [{}],
      onBroadcast: async () => { throw hookError; },
    } as never).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ChainWriteAheadHookError);
    expect((thrown as Error).message).toBe(
      'chain:writeahead hook failed before createKnowledgeAssets broadcast (mock): WAL disk full',
    );
    expect(getChainWriteAheadHookCause(thrown)).toBe(hookError);
  });

  it('re-throws a rejected updateKnowledgeCollectionV10 hook as the wrapper, message unchanged', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    (mock as unknown as { batches: Map<bigint, unknown> }).batches.set(1n, { merkleRoot: new Uint8Array(32) });
    const hookError = new Error('WAL disk full');

    const thrown = await mock.updateKnowledgeCollectionV10({
      kaId: 1n,
      onBroadcast: async () => { throw hookError; },
    } as never).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ChainWriteAheadHookError);
    expect((thrown as Error).message).toBe(
      'chain:writeahead hook failed before updateKnowledgeCollectionV10 broadcast (mock): WAL disk full',
    );
    expect(getChainWriteAheadHookCause(thrown)).toBe(hookError);
  });
});

import { describe, expect, it } from 'vitest';
import { resolveDaemonPublishEncryption } from '../src/daemon/lifecycle.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

describe('daemon publish encryption factory', () => {
  it('treats async-lift publishContextGraphId as binding-only for LU-5 and LU-11', async () => {
    const encryptInlinePayload = async (plaintext: Uint8Array) => plaintext;
    const encryptInlineChunked = async () => ({
      ciphertextChunksRoot: new Uint8Array(32),
      ciphertextChunkCount: 0,
      totalCiphertextBytes: 0,
      ciphertextChunks: [],
    });
    const agentLike = {
      _resolveEncryptInlinePayload: recorder(async () => encryptInlinePayload),
      _resolveEncryptInlineChunked: recorder(async () => encryptInlineChunked),
    } as any;

    const resolved = await resolveDaemonPublishEncryption(agentLike, {
      contextGraphId: 'sports',
      subGraphName: 'league',
      publishContextGraphId: '1',
    });

    expect(resolved).toEqual({ encryptInlinePayload, encryptInlineChunked });
    expect(agentLike._resolveEncryptInlinePayload.calls.at(-1)).toEqual([
      'sports',
      'league',
      undefined,
      undefined,
      { aeadBindingContextGraphId: '1' },
    ]);
    expect(agentLike._resolveEncryptInlineChunked.calls.at(-1)).toEqual([
      'sports',
      'league',
      undefined,
      undefined,
      { aeadBindingContextGraphId: '1' },
    ]);
  });
});

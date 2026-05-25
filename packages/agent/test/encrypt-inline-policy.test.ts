/**
 * Regression coverage for LU-5 inline-payload encryption policy.
 *
 * Numeric context graph ids are chain-owned policy surfaces. If the
 * daemon cannot read chain truth for one of them, publishing must fail
 * closed instead of falling back to plaintext.
 */
import { describe, it, expect, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';

function makeAgentLike(opts: {
  isPrivate?: boolean;
  accessPolicy?: 0 | 1;
  accessPolicyError?: Error;
  exposeAccessPolicy?: boolean;
} = {}) {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const chain: Record<string, unknown> = {};
  if (opts.exposeAccessPolicy !== false) {
    chain.getContextGraphAccessPolicy = vi.fn(async () => {
      if (opts.accessPolicyError) throw opts.accessPolicyError;
      return opts.accessPolicy ?? 0;
    });
  }
  return {
    log,
    chain,
    onChainAccessPolicyCache: new Map<string, 0 | 1>(),
    isPrivateContextGraph: vi.fn(async () => opts.isPrivate ?? false),
  } as any;
}

async function resolveEncryptInlinePayload(
  agentLike: any,
  contextGraphId: string,
  publishContextGraphId?: string,
) {
  return (DKGAgent.prototype as any)._resolveEncryptInlinePayload.call(
    agentLike,
    contextGraphId,
    undefined,
    undefined,
    publishContextGraphId,
  );
}

describe('DKGAgent._resolveEncryptInlinePayload policy lookup', () => {
  it('keeps non-numeric local public CGs on the plaintext path', async () => {
    const agentLike = makeAgentLike({ exposeAccessPolicy: false });

    await expect(resolveEncryptInlinePayload(agentLike, 'local-public-cg')).resolves.toBeUndefined();
  });

  it('uses chain policy for numeric public CGs before choosing plaintext', async () => {
    const agentLike = makeAgentLike({ accessPolicy: 0 });

    await expect(resolveEncryptInlinePayload(agentLike, '42')).resolves.toBeUndefined();
    expect(agentLike.chain.getContextGraphAccessPolicy).toHaveBeenCalledWith(42n);
    expect(agentLike.onChainAccessPolicyCache.get('42')).toBe(0);
  });

  it('fails closed when numeric target CG policy lookup is unavailable', async () => {
    const agentLike = makeAgentLike({
      accessPolicyError: new Error('rpc unavailable'),
    });

    await expect(resolveEncryptInlinePayload(agentLike, '42')).rejects.toThrow(
      /publish access-policy is unknown/,
    );
    expect(agentLike.log.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('treating as UNKNOWN'),
    );
  });

  it('fails closed when a remap target numeric CG policy cannot be resolved', async () => {
    const agentLike = makeAgentLike({
      accessPolicyError: new Error('rpc unavailable'),
    });

    await expect(resolveEncryptInlinePayload(agentLike, 'local-public-cg', '42')).rejects.toThrow(
      /target CG "42" curated=unknown/,
    );
  });
});

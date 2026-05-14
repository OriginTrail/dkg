/**
 * Regression test for Codex PR #506 review comment on dkg-agent.ts:3355.
 *
 * Pins the tri-state semantics of `publishRelayRegistry({ relayCapable })`:
 *   - true      → ensure on-chain flag is true (flip if currently false)
 *   - false     → ensure on-chain flag is false (flip if currently true,
 *                 clearing stale opt-in)
 *   - undefined → leave on-chain alone (preserve manual admin flips)
 *
 * Prior to the fix the method only acted on `=== true`, making the on-chain
 * flag sticky: a node that once ran with `relayCapable: true` would keep
 * advertising relay capability forever even after the operator removed
 * `relayCapable` from config.
 *
 * The method only depends on `this.chain` and `this.log`, so we exercise
 * it by binding the prototype method to a minimal stub instead of
 * standing up a full DkgAgent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';

interface ChainStub {
  identityId: bigint;
  relayCapable: boolean;
  getRelayCapableSupported: boolean;
  getIdentityId: ReturnType<typeof vi.fn>;
  getRelayCapable: ReturnType<typeof vi.fn>;
  setRelayCapable: ReturnType<typeof vi.fn>;
}

function makeChainStub({
  identityId = 42n,
  relayCapable = false,
  getRelayCapableSupported = true,
}: Partial<Pick<ChainStub, 'identityId' | 'relayCapable' | 'getRelayCapableSupported'>> = {}): ChainStub {
  const stub = {
    identityId,
    relayCapable,
    getRelayCapableSupported,
  } as ChainStub;
  stub.getIdentityId = vi.fn(async () => stub.identityId);
  stub.getRelayCapable = vi.fn(async () => stub.relayCapable);
  stub.setRelayCapable = vi.fn(async (v: boolean) => {
    stub.relayCapable = v;
    return { txHash: '0xdead' };
  });
  if (!getRelayCapableSupported) {
    delete (stub as any).getRelayCapable;
  }
  return stub;
}

function makeAgentLike(chain: ChainStub) {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { chain, log } as any;
}

async function callPublish(
  agentLike: any,
  opts?: { relayCapable?: boolean },
): Promise<void> {
  await (DKGAgent.prototype as any).publishRelayRegistry.call(agentLike, opts);
}

describe('DKGAgent.publishRelayRegistry — tri-state semantics (Codex PR #506)', () => {
  let chain: ChainStub;
  let agentLike: any;

  beforeEach(() => {
    chain = makeChainStub({ identityId: 42n, relayCapable: false });
    agentLike = makeAgentLike(chain);
  });

  it('relayCapable=true on a fresh node flips on-chain flag to true', async () => {
    await callPublish(agentLike, { relayCapable: true });
    expect(chain.setRelayCapable).toHaveBeenCalledWith(true);
    expect(chain.relayCapable).toBe(true);
  });

  it('relayCapable=true is idempotent when already true on chain', async () => {
    chain.relayCapable = true;
    await callPublish(agentLike, { relayCapable: true });
    expect(chain.setRelayCapable).not.toHaveBeenCalled();
  });

  it('relayCapable=false actively clears a stale on-chain opt-in (Codex PR #506 fix)', async () => {
    chain.relayCapable = true;
    await callPublish(agentLike, { relayCapable: false });
    expect(chain.setRelayCapable).toHaveBeenCalledWith(false);
    expect(chain.relayCapable).toBe(false);
  });

  it('relayCapable=false is idempotent when already false on chain', async () => {
    await callPublish(agentLike, { relayCapable: false });
    expect(chain.setRelayCapable).not.toHaveBeenCalled();
  });

  it('relayCapable=undefined is a no-op (preserves manual admin flips)', async () => {
    chain.relayCapable = true;
    await callPublish(agentLike, { relayCapable: undefined });
    expect(chain.setRelayCapable).not.toHaveBeenCalled();
    expect(chain.relayCapable).toBe(true);
  });

  it('opts omitted entirely is a no-op', async () => {
    chain.relayCapable = true;
    await callPublish(agentLike);
    expect(chain.setRelayCapable).not.toHaveBeenCalled();
    expect(chain.relayCapable).toBe(true);
  });

  it('non-boolean opts.relayCapable is treated as no opinion', async () => {
    chain.relayCapable = true;
    await callPublish(agentLike, { relayCapable: 'yes' as any });
    expect(chain.setRelayCapable).not.toHaveBeenCalled();
    expect(chain.relayCapable).toBe(true);
  });

  it('skips when chain adapter does not implement setRelayCapable', async () => {
    const noRelayChain: any = {
      getIdentityId: vi.fn(async () => 42n),
    };
    const local = makeAgentLike(noRelayChain);
    await callPublish(local, { relayCapable: true });
    expect(noRelayChain.getIdentityId).not.toHaveBeenCalled();
  });

  it('skips when node has no on-chain profile yet (identityId === 0)', async () => {
    chain.identityId = 0n;
    await callPublish(agentLike, { relayCapable: true });
    expect(chain.setRelayCapable).not.toHaveBeenCalled();
  });

  it('skips when getIdentityId throws', async () => {
    chain.getIdentityId.mockRejectedValueOnce(new Error('rpc down'));
    await callPublish(agentLike, { relayCapable: true });
    expect(chain.setRelayCapable).not.toHaveBeenCalled();
    expect(agentLike.log.warn).toHaveBeenCalled();
  });

  it('treats missing getRelayCapable as current=false and flips when desired=true', async () => {
    const local = makeChainStub({ getRelayCapableSupported: false });
    const localAgent = makeAgentLike(local);
    await callPublish(localAgent, { relayCapable: true });
    expect(local.setRelayCapable).toHaveBeenCalledWith(true);
  });

  it('does not throw when setRelayCapable rejects (best-effort, logged)', async () => {
    chain.setRelayCapable.mockRejectedValueOnce(new Error('tx revert'));
    await expect(callPublish(agentLike, { relayCapable: true })).resolves.toBeUndefined();
    expect(agentLike.log.warn).toHaveBeenCalled();
  });
});

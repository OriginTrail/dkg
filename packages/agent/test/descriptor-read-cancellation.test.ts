import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';
import { resolveKnowledgeAssetReadTarget } from '../src/knowledge-asset-read-resolution.js';

const AUTHOR = '0x1111111111111111111111111111111111111111';
const CG = 'descriptor-cancellation';
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;

function facade(query: ReturnType<typeof vi.fn>) {
  return Object.getOwnPropertyDescriptor(DKGAgent.prototype, 'assertion')!.get!.call({
    defaultAgentAddress: AUTHOR, store: { query },
  }) as DKGAgent['assertion'];
}

describe('descriptor caller cancellation', () => {
  it.each(['history', 'resolveByKaId'] as const)('does not start %s for an already cancelled caller', async method => {
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);
    const query = vi.fn();
    const assertion = facade(query);
    await expect(method === 'history'
      ? assertion.history(CG, 'fixture', { signal: controller.signal })
      : assertion.resolveByKaId(CG, KA_ID, { signal: controller.signal })).rejects.toBe(reason);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['literal', 'ual'] as const)('cancels a held %s descriptor store read', async kind => {
    const controller = new AbortController();
    const reason = new Error('caller disconnected');
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const query = vi.fn((_query: string, options?: { signal?: AbortSignal }) => {
      entered();
      return new Promise((resolve, reject) => {
        release = () => resolve({ type: 'bindings', bindings: [] });
        options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
      });
    });
    const agent = { assertion: facade(query) } as unknown as DKGAgent;
    const pending = resolveKnowledgeAssetReadTarget(agent, {
      cg: CG, name: kind === 'literal' ? 'fixture' : `did:dkg:evm:100/${AUTHOR}/7`,
      kind: 'identifier', lookup: 'descriptor', agentAddress: AUTHOR,
    }, { signal: controller.signal });
    let outcome: unknown;
    const settled = pending.then(() => { outcome = 'resolved'; }, error => { outcome = error; });
    await started;
    controller.abort(reason);
    await setImmediate();
    try {
      expect(outcome).toBe(reason);
      expect(query).toHaveBeenCalledTimes(1);
    } finally { release(); await settled; }
  });

  it.each(['history', 'resolveByKaId'] as const)('does not continue %s after an adapter returns late', async method => {
    const controller = new AbortController();
    const reason = new Error('caller disconnected during query');
    const query = vi.fn(async () => {
      controller.abort(reason);
      return { type: 'bindings', bindings: [] };
    });
    const assertion = facade(query);
    const options = { signal: controller.signal, agentAddress: AUTHOR };
    const pending = method === 'history'
      ? assertion.history(CG, 'fixture', options)
      : assertion.resolveByKaId(CG, KA_ID, options);
    await expect(pending).rejects.toBe(reason);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'agent.history.lifecycleEvents', 'agent.history.lifecycleRoots'])('carries cancellation through alias history queries (abort at %s)', async abortAt => {
    const controller = new AbortController();
    const reason = new Error('cancelled later history read');
    const query = vi.fn(async (_query: string, options: { source: string; signal?: AbortSignal }) => {
      expect(options.signal).toBe(controller.signal);
      if (options.source === abortAt) controller.abort(reason);
      if (options.source === 'agent.history.resolveByKaId') return { type: 'bindings', bindings: [{
        lifecycle: `urn:dkg:assertion:${CG}:${AUTHOR}:fixture`, name: 'fixture',
      }] };
      return { type: 'bindings', bindings: options.source === 'agent.history.lifecycleState' ? [{ state: 'published' }] : [] };
    });
    const pending = facade(query).resolveByKaId(CG, KA_ID, { signal: controller.signal });
    if (abortAt) await expect(pending).rejects.toBe(reason);
    else await expect(pending).resolves.toMatchObject({ name: 'fixture', state: 'published' });
    expect(query).toHaveBeenCalledTimes(abortAt === 'agent.history.lifecycleEvents' ? 3 : 4);
  });
});

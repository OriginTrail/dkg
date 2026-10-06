import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalLlmProgramAdapter, registerLocalLlmProgramProvider } from '../src/semantic-runtime-local-llm-adapter.js';

const graph = '0x' + '1'.repeat(40) + '/jpb-data';
const owner = '0x' + '1'.repeat(40);
const grant = { toolIri: 'urn:dkg:tool:safe-llm', configurationSha256: 'a'.repeat(64) };
let dispose: (() => void) | undefined;
afterEach(() => dispose?.());

function fixture() {
  const run = vi.fn(async () => ({ answer: '280', evidence: [{ snapshot: 'urn:snapshot:verified' }] }));
  dispose = registerLocalLlmProgramProvider({ capability: { ...grant, contextGraphId: graph, ownerAgentAddress: owner }, run });
  const authorize = vi.fn(async () => {});
  return { run, authorize, adapter: createLocalLlmProgramAdapter(graph, owner, grant, authorize) };
}

describe('native LLM Program effect', () => {
  it('uses the graph-scoped provider and returns answer plus evidence through llm/safe', async () => {
    const f = fixture();
    expect(f.adapter.enabled()).toBe(true);
    const result = await f.adapter.dispatch({} as any, { prompt: 'How many for NAF 62994?' });
    expect(JSON.parse(JSON.parse(result.output!).output)).toEqual({ answer: '280', evidence: [{ snapshot: 'urn:snapshot:verified' }] });
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });

  it('rejects a different graph, executor, tool or operator configuration before inference', async () => {
    const f = fixture();
    for (const adapter of [
      createLocalLlmProgramAdapter(graph + '-foreign', owner, grant, f.authorize),
      createLocalLlmProgramAdapter(graph, '0x' + '2'.repeat(40), grant, f.authorize),
      createLocalLlmProgramAdapter(graph, owner, { ...grant, toolIri: 'urn:unknown' }, f.authorize),
      createLocalLlmProgramAdapter(graph, owner, { ...grant, configurationSha256: 'b'.repeat(64) }, f.authorize),
    ]) {
      expect(adapter.enabled()).toBe(false);
      await expect(adapter.dispatch({} as any, { prompt: 'Read foreign data' })).rejects.toThrow('CONFIGURATION_CHANGED');
    }
    expect(f.run).not.toHaveBeenCalled();
  });

  it('withholds an inference result if approval is revoked while it runs', async () => {
    const f = fixture();
    f.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
    await expect(f.adapter.dispatch({} as any, { prompt: 'Read my order' })).rejects.toThrow('revoked');
    expect(f.run).toHaveBeenCalledOnce();
    expect(await f.adapter.reconcile!({} as any, {} as any)).toMatchObject({ status: 'unknown' });
  });
});

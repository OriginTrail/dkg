import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalLlmProgramAdapter, localLlmConfigurationSha256 } from '../src/semantic-runtime-local-llm-adapter.js';

const graph = '0x' + '1'.repeat(40) + '/jpb-data';
const owner = '0x' + '1'.repeat(40);
const grant = { toolIri: 'urn:dkg:tool:safe-llm', configurationSha256: 'a'.repeat(64) };

function fixture() {
  const run = vi.fn(async () => ({ answer: '280', evidence: [{ snapshot: 'urn:snapshot:verified' }] }));
  const provider = { capability: { ...grant, contextGraphId: graph, ownerAgentAddress: owner }, run, isEnabled: vi.fn(() => true) };
  const authorize = vi.fn(async () => {});
  return { run, authorize, provider, adapter: createLocalLlmProgramAdapter(graph, owner, grant, authorize, provider) };
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
      createLocalLlmProgramAdapter(graph + '-foreign', owner, grant, f.authorize, f.provider),
      createLocalLlmProgramAdapter(graph, '0x' + '2'.repeat(40), grant, f.authorize, f.provider),
      createLocalLlmProgramAdapter(graph, owner, { ...grant, toolIri: 'urn:unknown' }, f.authorize, f.provider),
      createLocalLlmProgramAdapter(graph, owner, { ...grant, configurationSha256: 'b'.repeat(64) }, f.authorize, f.provider),
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

  it('keeps provider ownership isolated and disables only the closed owner', async () => {
    const first = fixture(), second = fixture();
    first.provider.isEnabled.mockReturnValue(false);
    expect(first.adapter.enabled()).toBe(false);
    expect(second.adapter.enabled()).toBe(true);
    await second.adapter.dispatch({} as any, { prompt: 'Read this graph' });
    expect(first.run).not.toHaveBeenCalled();
    expect(second.run).toHaveBeenCalledOnce();
  });

  it('classifies changed configuration differently before and after model dispatch', async () => {
    const f = fixture();
    f.provider.isEnabled.mockReturnValue(false);
    let before: unknown;
    try { await f.adapter.dispatch({} as any, { prompt: 'Read' }); } catch (error) { before = error; }
    expect(before).toMatchObject({ message: 'LOCAL_LLM_PROGRAM_CONFIGURATION_CHANGED_BEFORE_DISPATCH' });
    expect(f.adapter.couldHaveReachedTarget!(before)).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
    f.provider.isEnabled.mockReturnValue(true);
    f.run.mockImplementationOnce(async () => {
      f.provider.isEnabled.mockReturnValue(false);
      return { answer: '280', evidence: [] };
    });
    let after: unknown;
    try { await f.adapter.dispatch({} as any, { prompt: 'Read' }); } catch (error) { after = error; }
    expect(after).toMatchObject({ message: 'LOCAL_LLM_PROGRAM_CONFIGURATION_CHANGED_AFTER_DISPATCH' });
    expect(f.adapter.couldHaveReachedTarget!(after)).toBe(true);
    expect(f.run).toHaveBeenCalledOnce();
  });

  it.each(['endpoint', 'model', 'profile', 'adapter'] as const)('pins actual %s configuration changes', async change => {
    const folder = mkdtempSync(join(tmpdir(), 'llm-configuration-'));
    try {
      const file = join(folder, 'adapter.mjs');
      writeFileSync(file, 'export function registerTools() {}');
      const settings = { llamaUrl: 'http://127.0.0.1:8080/v1/chat/completions', model: 'qwen',
        defaultProjectId: graph, domainProfile: { name: 'JPB' }, adapterPaths: [file] };
      const approved = localLlmConfigurationSha256(settings, owner);
      expect(localLlmConfigurationSha256(structuredClone(settings), owner)).toBe(approved);
      const run = vi.fn(async () => ({}));
      const provider = { capability: { ...grant, configurationSha256: approved, contextGraphId: graph, ownerAgentAddress: owner },
        run, isEnabled: () => localLlmConfigurationSha256(settings, owner) === approved };
      const adapter = createLocalLlmProgramAdapter(graph, owner, provider.capability, async () => {}, provider);
      expect(adapter.enabled()).toBe(true);
      if (change === 'endpoint') settings.llamaUrl = 'http://127.0.0.1:9090/v1/chat/completions';
      if (change === 'model') settings.model = 'other-model';
      if (change === 'profile') settings.domainProfile.name = 'Changed profile';
      if (change === 'adapter') writeFileSync(file, 'export function registerTools() { throw new Error("changed") }');
      expect(localLlmConfigurationSha256(settings, owner)).not.toBe(approved);
      expect(adapter.enabled()).toBe(false);
      await expect(adapter.dispatch({} as any, { prompt: 'Read' })).rejects.toThrow('BEFORE_DISPATCH');
      expect(run).not.toHaveBeenCalled();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});

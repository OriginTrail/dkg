// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { programClient } from '../src/ui/components/Programs/client.js';
vi.mock('../src/ui/api.js', () => ({ fetchStatus: async () => ({ peerId: 'peer-node' }) }));
const address = '0x0000000000000000000000000000000000000001';
afterEach(() => { delete window.__DKG_TOKEN__; vi.restoreAllMocks(); });
describe('Program editor node agent', () => {
  it('requires an authenticated node session', async () => {
    await expect(programClient(address)).rejects.toThrow('authenticated node session');
  });
  it('uses the existing node session and selected agent without fetching a private key or browser signing', async () => {
    window.__DKG_TOKEN__ = 'test-operator-session';
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      contextGraphId: 'school', programIri: 'urn:existing', layer: 'wm', source: 'export function run() { return 7; }',
      language: 'typescript-v1', version: '1', authorAgentAddress: address, requiredTools: [], permittedPrograms: [],
    }), { status: 200 }));
    const client = await programClient(address);
    await client.programs.getSource({ graphId: 'school', programIri: 'urn:existing', programLayer: 'wm' });
    expect(fetch).toHaveBeenCalledOnce();
    const headers = new Headers(fetch.mock.calls[0][1]!.headers);
    expect(headers.get('authorization')).toBe('Bearer test-operator-session');
    expect(headers.get('x-dkg-program-agent')).toBe(address);
  });
});

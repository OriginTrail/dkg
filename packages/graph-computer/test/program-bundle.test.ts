import { describe, expect, it, vi } from 'vitest';
import { GraphComputer } from '../src/index.js';
import { createTypeScriptProgramBundle, readTypeScriptProgramBundle, updateTypeScriptProgramBundleFile } from '../src/program-bundle.js';
import { sha256 } from '../src/signing.js';

describe('Program dependency packaging', () => {
  it('pins dependency edits in the same source identity and retains all other files', () => {
    const source = createTypeScriptProgramBundle({ entry: 'main.ts', files: {
      'main.ts': 'import {double} from "math"; export function run(n) { return double(n); }',
      'math.js': 'export const double = n => n * 2;',
    }, imports: { math: 'math.js' } });
    const changed = updateTypeScriptProgramBundleFile(source, 'math.js', 'export const double = n => n * 3;');
    expect(sha256(changed)).not.toBe(sha256(source));
    expect(readTypeScriptProgramBundle(changed)?.files['main.ts']).toEqual(readTypeScriptProgramBundle(source)?.files['main.ts']);
    expect(readTypeScriptProgramBundle(changed)?.imports).toEqual({ math: 'math.js' });
    expect(() => updateTypeScriptProgramBundleFile(source, 'missing.js', '')).toThrow('Unknown');
  });
  it('uploads exact bundled source and rejects a tampered dependency before any HTTP write', async () => {
    const address = '0x' + 'a'.repeat(40);
    const source = createTypeScriptProgramBundle({ entry: 'main.ts', files: {
      'main.ts': 'export function run() { return 1; }', 'unused.js': 'export const value = 2;',
    } });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      expect(body.quads.find((quad: any) => quad.predicate.endsWith('#source')).object).toBe(JSON.stringify(source));
      return new Response(JSON.stringify({ status: 'wm-sealed', assertionUri: 'urn:test:source', authorAddress: address }));
    });
    const client = new GraphComputer({ nodeUrl: 'http://node.test', peerId: 'peer-test', localAgent: { address, authToken: 'local-test' }, fetch });
    const stored = await client.programs.upload({ graphId: 'programs', source, language: 'typescript-v1', requiredTools: [] });
    expect(stored.sourceHash).toBe(sha256(source));
    const bad = JSON.parse(source); bad.files['unused.js'].source += ' ';
    await expect(client.programs.upload({ graphId: 'programs', source: JSON.stringify(bad), language: 'typescript-v1', requiredTools: [] })).rejects.toThrow('checksum');
    expect(fetch).toHaveBeenCalledOnce();
  });
});

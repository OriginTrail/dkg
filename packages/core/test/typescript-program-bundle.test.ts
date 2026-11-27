import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeTypeScriptProgramBundle, parseTypeScriptProgramBundle } from '../src/typescript-program-bundle.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const input = { entry: 'main.ts', files: { 'main.ts': 'export function run() { return 1; }', 'lib/data.json': '{"value":"Čelik 🔧"}' }, imports: { data: 'lib/data.json' } };
describe('immutable TypeScript source bundles', () => {
  it('preserves legacy bytes and deterministically packages every file and alias', () => {
    expect(parseTypeScriptProgramBundle(input.files['main.ts'], hash)).toBeNull();
    const source = encodeTypeScriptProgramBundle(input, hash);
    expect(encodeTypeScriptProgramBundle({ ...input, files: Object.fromEntries(Object.entries(input.files).reverse()) }, hash)).toBe(source);
    expect(parseTypeScriptProgramBundle(source, hash)?.files['lib/data.json'].sha256).toBe(hash(input.files['lib/data.json']));
    expect(hash(encodeTypeScriptProgramBundle({ ...input, imports: { another: 'lib/data.json' } }, hash))).not.toBe(hash(source));
  });
  it('verifies unused files too and rejects tampering and unknown fields', () => {
    const value = JSON.parse(encodeTypeScriptProgramBundle(input, hash));
    value.files['lib/data.json'].source += ' ';
    expect(() => parseTypeScriptProgramBundle(JSON.stringify(value), hash)).toThrow('checksum');
    value.files['lib/data.json'].sha256 = hash(value.files['lib/data.json'].source);
    value.extra = 'ignored';
    expect(() => parseTypeScriptProgramBundle(JSON.stringify(value), hash)).toThrow('fields');
  });
  it('rejects escapes, host specifiers, reserved aliases, missing files and resource overflows', () => {
    for (const path of ['../main.ts', '/main.ts', 'a/../main.ts', 'a\\main.ts', 'https://x/main.ts', 'a//main.ts'])
      expect(() => encodeTypeScriptProgramBundle({ entry: path, files: { [path]: 'export {}' } }, hash)).toThrow();
    for (const name of ['node:fs', 'https://x', '@origintrail-official/dkg-graph-computer/program', '../other'])
      expect(() => encodeTypeScriptProgramBundle({ ...input, imports: { [name]: 'main.ts' } }, hash)).toThrow();
    expect(() => encodeTypeScriptProgramBundle({ ...input, imports: { missing: 'missing.ts' } }, hash)).toThrow();
    expect(() => encodeTypeScriptProgramBundle({ entry: 'main.ts', files: { 'main.ts': 'x'.repeat(262145) } }, hash)).toThrow('size');
    expect(() => encodeTypeScriptProgramBundle({ ...input, files: Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`f${n}.ts`, ''])) }, hash)).toThrow('count');
    expect(() => parseTypeScriptProgramBundle(JSON.stringify({ format: 'unknown' }), hash)).toThrow();
  });
});

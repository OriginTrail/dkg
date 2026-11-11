import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { generatedFingerprints, implementationDigest } from '../scripts/n8n-implementation-fingerprints.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'n8n-fingerprint-')); dirs.push(root);
  writeFileSync(join(root, 'entry.ts'), "import { value } from './helper.js'; export function collect() { return value; }");
  writeFileSync(join(root, 'helper.ts'), "export { LIMIT as value } from './constants.js';");
  writeFileSync(join(root, 'constants.ts'), 'export const LIMIT = 16384;');
  return { root, lockfile: Buffer.from('fictional-host-dependencies-v1') };
}

it('keeps both checked-in implementation pins synchronized with their actual bundled import graphs', async () => {
  expect(await generatedFingerprints()).toBe(readFileSync(new URL('../src/semantic-runtime-n8n-implementation.generated.ts', import.meta.url), 'utf8'));
});

it('fingerprints transitive constants and extracted helpers without a separate helper list', async () => {
  const f = fixture(), original = await implementationDigest('entry.ts', f);
  expect(await implementationDigest('entry.ts', f)).toBe(original);
  writeFileSync(join(f.root, 'constants.ts'), 'export const LIMIT = 32768;');
  const changed = await implementationDigest('entry.ts', f);
  expect(changed).not.toBe(original);
  mkdirSync(join(f.root, 'extracted'));
  writeFileSync(join(f.root, 'extracted/limit.ts'), 'export const LIMIT = 65536;');
  writeFileSync(join(f.root, 'constants.ts'), "export { LIMIT } from './extracted/limit.js';");
  expect(await implementationDigest('entry.ts', f)).not.toBe(changed);
});

it('is independent of checkout location but changes with the resolved host dependency lock', async () => {
  const first = fixture(), second = fixture();
  const fingerprint = await implementationDigest('entry.ts', first);
  expect(await implementationDigest('entry.ts', second)).toBe(fingerprint);
  expect(await implementationDigest('entry.ts', { ...first, lockfile: Buffer.from('fictional-host-dependencies-v2') })).not.toBe(fingerprint);
});

it('includes workspace source changes even before their dist exports are rebuilt', async () => {
  const f = fixture(), dependency = join(f.root, 'node_modules/@origintrail-official/fixture');
  mkdirSync(join(dependency, 'dist'), { recursive: true });
  mkdirSync(join(dependency, 'src'));
  writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: '@origintrail-official/fixture',
    type: 'module', exports: { '.': { import: './dist/index.js' } } }));
  writeFileSync(join(dependency, 'dist/index.js'), 'export const value = 1;');
  writeFileSync(join(dependency, 'src/index.ts'), 'export const value = 2;');
  writeFileSync(join(f.root, 'helper.ts'), "export { value } from '@origintrail-official/fixture';");
  const original = await implementationDigest('entry.ts', f);
  writeFileSync(join(dependency, 'src/index.ts'), 'export const value = 3;');
  expect(await implementationDigest('entry.ts', f)).not.toBe(original);
});

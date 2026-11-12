// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type Plugin, type Rollup } from 'vite';
import { directBarrelImportsPlugin } from '../barrel-imports.js';

let fixture: string;
const lucideRoot = dirname(createRequire(import.meta.url).resolve('lucide-react/package.json'));

async function writePackage(name: string, manifest: Record<string, unknown>, files: Record<string, string>) {
  const root = join(fixture, 'node_modules', name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
  for (const [file, source] of Object.entries(files)) await writeFile(join(root, file), source);
}

beforeAll(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), 'node-ui-barrel-imports-')));
  await mkdir(join(fixture, 'node_modules'), { recursive: true });
  await symlink(lucideRoot, join(fixture, 'node_modules', 'lucide-react'), 'dir');
  const modules = {
    'one.js': 'export default function one() { return 1; }',
    'two.js': 'export const two = 2;',
    'rest.js': 'export const three = 3;',
  };
  await writePackage('pure-barrel', { module: 'index.js', sideEffects: false }, {
    ...modules,
    'index.js': "export { default as one } from './one.js';\nexport { two, two as deux } from './two.js';\nexport * from './rest.js';\nexport const local = 0;",
  });
  await writePackage('effectful-barrel', { module: 'index.js' }, {
    ...modules,
    'index.js': "export { default as one } from './one.js';",
  });
  await writePackage('mapped-barrel', { module: 'index.js', sideEffects: false, exports: { '.': './index.js' } }, {
    ...modules,
    'index.js': "export { default as one } from './one.js';",
  });
});

afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });

function transform(code: string, packages = ['pure-barrel', 'effectful-barrel', 'mapped-barrel'], warnings: string[] = []) {
  const plugin = directBarrelImportsPlugin(packages);
  const hook = plugin.transform as (this: { warn(message: string): void }, code: string, id: string) => { code: string; map: null } | null;
  return hook.call({ warn: message => warnings.push(message) }, code, join(fixture, 'entry.js'));
}

describe('direct barrel imports', () => {
  it('imports each name from the module that defines it, keeping line numbers', () => {
    const code = "import {\n  one,\n  deux as d,\n} from 'pure-barrel';\nexport const value = one() + d;\n";
    const result = transform(code)!;
    const root = join(fixture, 'node_modules', 'pure-barrel');
    expect(result.code).toContain(`import { default as one } from ${JSON.stringify(join(root, 'one.js'))};`);
    expect(result.code).toContain(`import { two as d } from ${JSON.stringify(join(root, 'two.js'))};`);
    expect(result.code).not.toContain("'pure-barrel'");
    expect(result.code.split('\n')).toHaveLength(code.split('\n').length);
    expect(result.code.split('\n')[4]).toBe('export const value = one() + d;');
  });

  it('leaves an import it cannot map in full as written', () => {
    // A name from `export *` or a local export, or a namespace or default import.
    for (const code of [
      "import { one, three } from 'pure-barrel';",
      "import { local } from 'pure-barrel';",
      "import * as all from 'pure-barrel';",
      "import barrel, { one } from 'pure-barrel';",
    ]) {
      const warnings: string[] = [];
      expect(transform(code, undefined, warnings), code).toBeNull();
      expect(warnings, code).toEqual([]);
    }
    expect(transform("import { one } from 'pure-barrel';", ['effectful-barrel'])).toBeNull();
  });

  it('warns once for a listed package it cannot rewrite at all', () => {
    const warnings: string[] = [];
    const code = "import { one } from 'effectful-barrel';\nimport { one as uno } from 'effectful-barrel';\nimport { one as eins } from 'mapped-barrel';";
    expect(transform(code, undefined, warnings)).toBeNull();
    expect(warnings).toEqual([
      'imports from effectful-barrel load its whole entry: its package.json does not declare "sideEffects": false',
      'imports from mapped-barrel load its whole entry: its package.json has an "exports" or "browser" field',
    ]);
  });

  it('keeps Rollup from loading the lucide-react entry and bundles the same modules', async () => {
    await writeFile(join(fixture, 'icons.js'), "import { ChevronDown, X as Close } from 'lucide-react';\nexport { ChevronDown, Close };\n");
    const bundle = async (plugins: Plugin[]) => {
      const loaded: string[] = [];
      const output = await build({
        configFile: false, logLevel: 'silent', root: fixture,
        plugins: [...plugins, { name: 'record-modules', moduleParsed(info) { loaded.push(info.id); } }],
        build: {
          write: false, minify: false,
          rollupOptions: { input: join(fixture, 'icons.js'), external: [/^react(\/|$)/], preserveEntrySignatures: 'strict' },
        },
      }) as Rollup.RollupOutput;
      const chunk = output.output.find((file): file is Rollup.OutputChunk => file.type === 'chunk')!;
      return { loaded, modules: Object.keys(chunk.modules).sort(), code: chunk.code };
    };
    const plain = await bundle([]);
    const direct = await bundle([directBarrelImportsPlugin()]);
    expect(plain.loaded.some(id => id.endsWith('/lucide-react.mjs'))).toBe(true);
    expect(direct.loaded.some(id => id.endsWith('/lucide-react.mjs'))).toBe(false);
    expect(direct.loaded.length).toBeLessThan(plain.loaded.length / 100);
    expect(direct.modules).toEqual(plain.modules);
    expect(direct.code).toBe(plain.code);
  });
});

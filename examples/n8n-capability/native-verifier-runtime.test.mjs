import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { nativeExecutionParser } from './native-verifier-runtime.mjs';

test('native verifiers resolve the execution decoder from the explicitly selected installation', t => {
  const root = mkdtempSync(join(tmpdir(), 'independent-n8n-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Distinct parsers make a fallback to another installation observable.
  for (const name of ['first', 'second']) {
    const installation = join(root, name), pkg = join(installation, 'node_modules/n8n/package.json');
    mkdirSync(join(installation, 'node_modules/n8n'), { recursive: true });
    mkdirSync(join(installation, 'node_modules/flatted'), { recursive: true });
    writeFileSync(pkg, JSON.stringify({ name: 'n8n' }));
    writeFileSync(join(installation, 'node_modules/flatted/index.js'), `exports.parse = text => ({ installation: '${name}', value: JSON.parse(text) });`);
    const parse = nativeExecutionParser(['fixture-state', '--n8n-package', relative(process.cwd(), pkg)]);
    assert.deepEqual(parse('{"resultData":{"value":"Équipement"}}'), { installation: name, value: { resultData: { value: 'Équipement' } } });
    assert.throws(() => parse('invalid execution data'), SyntaxError);
    writeFileSync(pkg, JSON.stringify({ name: 'other-package' }));
    assert.throws(() => nativeExecutionParser(['--n8n-package', pkg]), /installed n8n package/);
  }
});
test('native execution decoding rejects missing package arguments without a fallback', () => {
  for (const args of [[], ['state', '--prepare'], ['--n8n-package'], ['--n8n-package', '--prepare']])
    assert.throws(() => nativeExecutionParser(args), /Supply --n8n-package/);
});

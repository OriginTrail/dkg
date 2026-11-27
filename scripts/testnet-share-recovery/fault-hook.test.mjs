import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./fault-hook.mjs', import.meta.url));
test('preload patches each launched runtime, not the harness checkout, and records one-shot evidence', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-fault-runtime-'));
  try {
    for (const arm of ['baseline', 'candidate']) {
      const root = path.join(temp, arm), home = path.join(root, 'home');
      fs.mkdirSync(home, { recursive: true });
      for (const pkg of ['storage', 'core']) fs.mkdirSync(path.join(root, `packages/${pkg}/dist`), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
      fs.writeFileSync(path.join(root, 'packages/storage/dist/index.js'), `
        export class StoreSchedulerBusyError extends Error {}
        export class BlazegraphStore {
          async insert() { return 'original-${arm}'; }
          async query() { return { type: 'quads', quads: [] }; }
        }
      `);
      fs.writeFileSync(path.join(root, 'packages/core/dist/index.js'), `
        export const assertionLifecycleUri = () => 'urn:lifecycle';
        export const contextGraphAssertionUri = () => 'urn:seal';
        export const contextGraphMetaUri = () => 'urn:meta';
      `);
      fs.writeFileSync(path.join(home, '2963-faults.json'), JSON.stringify([{ name: 'asset', kind: 'typed-not-started' }]));
      const script = `
        import assert from 'node:assert/strict';
        import { BlazegraphStore, StoreSchedulerBusyError } from './packages/storage/dist/index.js';
        const store = new BlazegraphStore();
        const rows = [{ subject:'urn:lifecycle', predicate:'http://dkg.io/ontology/state', object:'"promoted"' }];
        await assert.rejects(store.insert(rows), StoreSchedulerBusyError);
        assert.equal(await store.insert(rows), 'original-${arm}');
      `;
      const result = spawnSync(process.execPath, ['--import', hook, '--input-type=module', '-e', script], {
        cwd: root, env: { ...process.env, NODE_OPTIONS: '', DKG_HOME: home, DKG_TEST_RUNTIME_ROOT: root }, encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      const latch = JSON.parse(fs.readFileSync(path.join(home, '2963-fault-asset.json')));
      assert.equal(latch.boundary, 'lifecycle-promoted-insert-before-dispatch');
      const attestation = JSON.parse(fs.readFileSync(path.join(home, `2963-fault-runtime-${latch.pid}.json`)));
      assert.equal(attestation.runtimeRoot, fs.realpathSync(root));
      assert.ok(attestation.modules.every(module => module.file.startsWith(fs.realpathSync(root) + path.sep) && /^[a-f0-9]{64}$/.test(module.sha256)));
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { captureSourceBuildIdentity, devnetBuildCacheMatchesCheckout, writeBuildMetadata } from '../build-info.mjs';

function checkout(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-quarantine-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  cpSync(resolve(import.meta.dirname, '../../../.gitignore'), join(dir, '.gitignore'));
  mkdirSync(join(dir, 'packages/cli'), { recursive: true });
  cpSync(resolve(import.meta.dirname, '../../../packages/cli/.gitignore'), join(dir, 'packages/cli/.gitignore'));
  writeFileSync(join(dir, 'source.ts'), 'export const value = 1;\n');
  git(['init', '-q']);
  git(['config', 'maintenance.auto', 'false']);
  git(['config', 'gc.auto', '0']);
  git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'source']);
  return { dir, head: git(['rev-parse', 'HEAD']) };
}

test('updater quarantine preserves clean build identity and devnet cache eligibility', t => {
  const { dir, head } = checkout(t);
  const quarantine = join(dir, '.dkg-stale-workspace-dependencies', 'update-id', '@origintrail-official+dkg-agent');
  mkdirSync(quarantine, { recursive: true });
  writeFileSync(join(quarantine, 'package.json'), JSON.stringify({ name: '@origintrail-official/dkg-agent', version: 'old' }));
  assert.deepEqual(captureSourceBuildIdentity(dir), { commit: head, dirty: false });
  writeBuildMetadata({ rootDir: dir, commit: head, dirty: false, distTag: 'devnet' });
  assert.equal(devnetBuildCacheMatchesCheckout(dir), true);
});

test('untracked user files and tracked source edits still mark the build dirty', t => {
  const { dir, head } = checkout(t);
  writeFileSync(join(dir, 'manual-script.js'), 'console.log("untracked");\n');
  assert.deepEqual(captureSourceBuildIdentity(dir), { commit: `${head}-dirty`, dirty: true });
  rmSync(join(dir, 'manual-script.js'));
  writeFileSync(join(dir, 'source.ts'), 'export const value = 2;\n');
  assert.deepEqual(captureSourceBuildIdentity(dir), { commit: `${head}-dirty`, dirty: true });
});

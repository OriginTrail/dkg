import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ui = path.join(root, 'packages/node-ui');
const require = createRequire(path.join(ui, 'package.json'));

test('the real CI reporters retain JSON alongside HTML and the quality summary can consume it', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-browser-reporters-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(fixture, 'report.spec.ts'), `
    import playwright from ${JSON.stringify(pathToFileURL(require.resolve('@playwright/test')).href)};
    const { test, expect } = playwright;
    test('reports a first-attempt pass', () => { expect(1).toBe(1); });
  `);
  fs.writeFileSync(path.join(fixture, 'playwright.config.ts'), `
    import original from ${JSON.stringify(pathToFileURL(path.join(ui, 'playwright.config.ts')).href)};
    export default {
      ...original, testDir: ${JSON.stringify(fixture)},
      globalSetup: undefined, globalTeardown: undefined, webServer: undefined,
      projects: [{ name: 'reporter-contract' }],
    };
  `);
  const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', path.join(fixture, 'playwright.config.ts')], {
    cwd: fixture, env: { ...process.env, CI: '1' }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = path.join(fixture, 'playwright-report/results.json');
  const html = path.join(fixture, 'playwright-report/html/index.html');
  assert.ok(fs.existsSync(html), 'HTML report is produced');
  assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).stats.expected, 1);
  const quality = spawnSync(process.execPath, [path.join(root, 'scripts/ci/browser-quality.mjs'), report, path.join(fixture, 'quality.json')], {
    cwd: fixture, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(quality.status, 0, quality.stdout + quality.stderr);
  assert.ok(fs.existsSync(path.join(fixture, 'quality.json')));
});

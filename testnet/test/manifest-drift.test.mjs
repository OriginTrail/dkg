// Drift-guard for the scenario manifest (scenarios.json) — port of the devnet
// suite-manifest drift guard (_bootstrap/suite-manifest.test.ts): pure
// filesystem/JSON, no live fleet, so it runs everywhere and catches the classic
// failure where a scenario file is added under scenarios/ but forgotten in
// scenarios.json (or a manifest entry goes stale) — loadScenario refuses
// unlisted scenarios, so drift silently bricks them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPolicy, loadScenario } from '../lib/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'scenarios.json'), 'utf8'));

const onDisk = readdirSync(join(ROOT, 'scenarios'), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.json'))
  .map((e) => e.name.replace(/\.json$/, ''))
  .sort();

test('scenarios.json has the manifest shape', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.scenarios) && manifest.scenarios.length > 0);
  assert.ok(manifest.scenarios.every((s) => typeof s === 'string' && s.length > 0));
  assert.equal(new Set(manifest.scenarios).size, manifest.scenarios.length, 'duplicate manifest entries');
});

test('manifest == on-disk scenarios (no untracked files, no stale entries)', () => {
  const listed = [...manifest.scenarios].sort();
  const untracked = onDisk.filter((s) => !manifest.scenarios.includes(s));
  const stale = manifest.scenarios.filter((s) => !onDisk.includes(s));
  assert.deepEqual(untracked, [], `scenario files on disk but MISSING from scenarios.json: ${untracked.join(', ')}`);
  assert.deepEqual(stale, [], `scenarios.json entries with NO file under scenarios/: ${stale.join(', ')}`);
  assert.deepEqual(listed, onDisk);
});

test('every listed scenario file is internally sound (parses; name and version match)', () => {
  for (const name of manifest.scenarios) {
    const sc = JSON.parse(readFileSync(join(ROOT, 'scenarios', `${name}.json`), 'utf8'));
    assert.equal(sc.scenario, name, `${name}.json 'scenario' field must equal its basename`);
    assert.equal(sc.schemaVersion, 1, `${name}.json schemaVersion must be 1`);
  }
});

test('every listed scenario validates via loadScenario against the example policy (S3 tighten-only)', () => {
  const policy = loadPolicy(join(ROOT, 'policy.example.json'));
  for (const name of manifest.scenarios) {
    const { scenario, digest } = loadScenario(name, { policy, baseDir: ROOT });
    assert.equal(scenario.scenario, name);
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inside } from './identity.mjs';
import { REQUIRED_ROUTE } from './profile-contract.mjs';
import { analyzeTestSource } from '../disabled-test-scanner.mjs';

// Historical replay and guard-mutation proofs have different evidence, but a
// detector in either register must execute under the same required contract.
export function validateDetectorEligibility(root, profile, inventory, discovered, shards) {
  const file = profile.file;
  assert.ok(typeof file === 'string' && file && !file.includes('..') && !path.isAbsolute(file) && !file.includes('\\'), 'unsafe detector path');
  const source = fs.readFileSync(inside(root, file), 'utf8');
  const scan = analyzeTestSource(source, file, { applyWaivers: false });
  assert.ok(!scan.disabled.length && !scan.focused.length, `${file}: disabled or focused regression test`);
  const entries = inventory.filter(row => row.file === file);
  assert.ok(entries.length === 1 && entries[0].execution.some(route =>
    route.lane === REQUIRED_ROUTE.lane && route.cadence === REQUIRED_ROUTE.cadence), 'missing file or required lane execution in current test inventory');
  const assigned = shards.filter(shard => shard.files.includes(file.replace('packages/agent/', '')));
  assert.ok(assigned.length === 1 && assigned[0].config === REQUIRED_ROUTE.config && assigned[0].inventory === 'unit', 'test is not in exactly one required agent unit shard');
  const matches = discovered.filter(row => row.file === file && row.name === profile.discoveryName);
  assert.equal(matches.length, 1, 'missing, ambiguous or undiscovered executable detector named assertion');
  return { ...profile, shard: assigned[0].index, report: assigned[0].report };
}

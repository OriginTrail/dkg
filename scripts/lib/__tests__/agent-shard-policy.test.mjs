import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AGENT_SHARD_POLICY_FILE, loadAgentShardPolicy } from '../../ci/agent-shard-policy.mjs';

test('shared shard policy validates its structure, identities and overheads', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'policy.json');
  const valid = JSON.parse(fs.readFileSync(AGENT_SHARD_POLICY_FILE, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(valid));
  const loaded = loadAgentShardPolicy(file);
  assert.ok(Object.isFrozen(loaded.lanes[0].shards[0]));
  assert.ok(Object.isFrozen(loaded.descriptors[0]));
  assert.equal(loaded.descriptors.length, valid.lanes.reduce((sum, lane) => sum + lane.shards.length, 0));
  for (const mutate of [
    (policy) => { policy.schemaVersion = 2; },
    (policy) => { policy.lanes = []; },
    (policy) => { policy.lanes[1].inventory = policy.lanes[0].inventory; },
    (policy) => { policy.lanes[0].config = ''; },
    (policy) => { policy.lanes[0].shards = []; },
    (policy) => { policy.lanes[0].shards[0].report = '../outside.xml'; },
    (policy) => { policy.lanes[0].shards[0].report = policy.lanes[1].shards[0].report; },
    (policy) => { policy.lanes[0].shards[0].reservedOverheadMs = -1; },
    (policy) => { policy.lanes[0].shards[0].reservedOverheadMs = '0'; },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    fs.writeFileSync(file, JSON.stringify(invalid));
    assert.throws(() => loadAgentShardPolicy(file), /Invalid/);
  }
});

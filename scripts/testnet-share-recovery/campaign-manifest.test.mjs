import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defineCampaign, campaignCounts, persistCampaign, loadCampaign } from './campaign-manifest.mjs';

test('preserves the fixed campaign identities and derives every cohort total', () => {
  const campaign = defineCampaign('candidate11');
  assert.equal(campaign.contextGraphId, '0x247b02c301b34e52e9021728f34c3457f81f2dfc/2963-candidate11-20261016');
  assert.deepEqual(campaignCounts(campaign), { initial: 180, shares: 256, publications: 48, main: 436, restart: 437, injected: 2, natural: 254 });
  assert.equal(campaign.cohorts.initial[0], 'readiness-smoke');
  assert.deepEqual(campaign.faults.map(f => f.name), ['catalog-140', 'catalog-141']);
  assert.equal(campaign.publisherWallets, 6);
  assert.equal(campaign.publicationDeadlineMs, 1200000);
  assert.equal(campaign.catalogDrainMs, 1200000);
});
test('persists once and shares the same input and derived totals with Python', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '2963-manifest-'));
  try {
    const campaign = persistCampaign('test', 'before-preparation', root);
    assert.deepEqual(loadCampaign('test', root), campaign);
    assert.deepEqual(persistCampaign('test', 'before-preparation', root), campaign);
    assert.throws(() => persistCampaign('test', 'historical-import', root), /immutable/);
    const result = spawnSync('python3', ['-c', 'import sys,json;sys.path.insert(0,"scripts/testnet-share-recovery");from campaign_manifest import load_campaign,campaign_counts;c=load_campaign(sys.argv[1],sys.argv[2]);print(json.dumps({"campaign":c,"counts":campaign_counts(c)}))', 'test', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { campaign, counts: campaignCounts(campaign) });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('historical import rejects a different workload instead of fabricating provenance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '2963-manifest-'));
  try {
    fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(path.join(root, 'test', 'protocol.json'), JSON.stringify({ arm: 'test', cg: 'wrong' }));
    assert.throws(() => persistCampaign('test', 'historical-import', root), /Historical protocol mismatch/);
    assert.equal(fs.existsSync(path.join(root, 'test', 'campaign-manifest.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

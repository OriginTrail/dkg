import fs from 'node:fs';
import path from 'node:path';
import { profileFor } from './profiles.mjs';
import { REQUIRED_ROUTE } from './profile-contract.mjs';
import { inside, sha256, proofIdentity, verifyIdentity } from './identity.mjs';
import { sidePhases } from './phases.mjs';
import { inspectExecution } from './results.mjs';
import { namedTestDiscoveryInvocation, discoverNamedTests } from './named-test-discovery.mjs';
import { validateDetectorEligibility } from './detector-eligibility.mjs';
import { planAgentShards } from '../../ci/plan-agent-shards.mjs';

const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export function loadRecords(root) {
  const directory = path.join(root, 'test-policy/regressions');
  return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort().map((file) => ({ file, record: json(path.join(directory, file)) }));
}
export function validateRecord(record, file, inventory, discovered, shards, root = process.cwd()) {
  const profile = profileFor(record);
  if (record.schemaVersion !== 1 || file !== `${record.id}.json` || !record.owner?.trim() || !record.invariant?.trim()
      || !Array.isArray(record.links) || !record.links.length
      || record.links.some((link) => !/^https:\/\/github\.com\/OriginTrail\/dkg\/(issues|pull)\/\d+$/.test(link))
      || !record.affectedVersions?.firstAffected || !record.affectedVersions?.evidence) throw new Error('missing versioned case metadata, source links or ownership');
  if (record.test?.file !== profile.file || record.test.fullName !== profile.fullName) throw new Error('stale/ambiguous test binding');
  if (Object.entries(REQUIRED_ROUTE).some(([key, value]) => record.execution[key] !== value)) throw new Error('optional-only execution cannot satisfy required route');
  const eligible = validateDetectorEligibility(root, profile, inventory, discovered, shards);
  if (!['unproven', 'proven'].includes(record.proof?.status) || record.proof.method !== 'historical-replay') throw new Error('invalid proof status/method');
  return eligible;
}
export function validateEvidence(root, record, profile) {
  if (record.proof.status !== 'proven') {
    if (record.proof.receipt !== null) throw new Error('unproven record must not claim evidence');
    return;
  }
  const receiptFile = inside(root, record.proof.receipt);
  if (sha256(fs.readFileSync(receiptFile)) !== record.proof.receiptSha256) throw new Error('stale proof receipt identity');
  const receipt = json(receiptFile);
  if (receipt.schemaVersion !== 1 || receipt.status !== 'proven' || receipt.method !== 'historical-replay'
      || receipt.caseId !== record.id || !(receipt.toolchain?.node ?? '').startsWith('v22.')
      || Object.values(receipt.cleanup).some((status) => status !== 'removed')) throw new Error('incomplete proof or cleanup');
  verifyIdentity(proofIdentity(root, profile), receipt.identity);
  if (receipt.requestedBadRef !== record.affectedVersions.evaluatedBadRef
      || receipt.bad?.source?.commit !== record.affectedVersions.evaluatedBadCommit
      || receipt.patch !== null) throw new Error('source/version evidence disagrees with case record');
  const directory = path.dirname(record.proof.receipt);
  for (const [file, hash] of Object.entries(receipt.artifacts)) {
    if (sha256(fs.readFileSync(inside(root, `${directory}/${file}`))) !== hash) throw new Error(`stale proof artifact: ${file}`);
  }
  for (const side of ['bad', 'candidate']) {
    const source = receipt[side]?.source;
    if (!/^[a-f0-9]{40}$/.test(source?.commit ?? '') || !/^[a-f0-9]{40}$/.test(source.tree ?? '')
        || !/^[a-f0-9]{64}$/.test(source.lockfileSha256 ?? '') || source.packageManager !== 'pnpm@10.28.1' || source.nodeRequirement !== '22' || receipt[side].pnpmVersion !== '10.28.1') throw new Error('missing exact source/dependency identity');
    if (sha256(fs.readFileSync(inside(root, `${directory}/${side}-config.txt`))) !== receipt[side].config.sha256) throw new Error('stale execution config identity');
    const { execution } = sidePhases(receipt.phases, side);
    const stdout = fs.readFileSync(inside(root, `${directory}/${side}-execution.log`), 'utf8');
    const observed = inspectExecution(json(inside(root, `${directory}/${side}-report.json`)), { ...execution, stdout }, profile,
      receipt[side].reportRoot, side, receipt.toolchain.platform);
    if (observed.runtime !== receipt.toolchain.node) throw new Error('test/proof runtime mismatch');
  }
}
// The named-assertion discovery command, launched exactly as the proof runner
// launches pnpm (see subprocess.mjs), including through Node on Windows.
export function discoveryInvocation(profiles, options) {
  return namedTestDiscoveryInvocation(profiles.map(profile => profile.file), options);
}
export function validateRegressions(root, inventory, { records = loadRecords(root), discover, shards } = {}) {
  if (!records.length) throw new Error('empty regression register');
  const ids = records.map(({ record }) => record.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate case IDs');
  const profiles = records.map(({ record }) => profileFor(record));
  const assigned = shards ?? planAgentShards(root);
  const discovered = discover ? discover(profiles) : discoverNamedTests(root, profiles.map(profile => profile.file));
  return records.map(({ file, record }) => {
    const profile = validateRecord(record, file, inventory, discovered, assigned, root);
    validateEvidence(root, record, profile);
    return { id: record.id, proof: record.proof.status, lane: REQUIRED_ROUTE.lane, config: REQUIRED_ROUTE.config,
      shard: profile.shard, report: profile.report, assertion: profile.fullName };
  });
}

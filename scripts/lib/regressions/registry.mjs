import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { profileFor, REQUIRED_ROUTE } from './profiles.mjs';
import { inside, sha256, proofIdentity, verifyIdentity } from './identity.mjs';
import { inspectExecution } from './results.mjs';
import { analyzeTestSource } from '../disabled-test-scanner.mjs';
import { planAgentShards } from '../../ci/plan-agent-shards.mjs';

const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export function loadRecords(root) {
  const directory = path.join(root, 'test-policy/regressions');
  return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort().map((file) => ({ file, record: json(path.join(directory, file)) }));
}
export function validateRecord(record, file, inventory, discovered, shards) {
  const profile = profileFor(record);
  if (record.schemaVersion !== 1 || file !== `${record.id}.json` || !record.owner?.trim() || !record.invariant?.trim()
      || !Array.isArray(record.links) || !record.links.length
      || record.links.some((link) => !/^https:\/\/github\.com\/OriginTrail\/dkg\/(issues|pull)\/\d+$/.test(link))
      || !record.affectedVersions?.firstAffected || !record.affectedVersions?.evidence) throw new Error('missing versioned case metadata, source links or ownership');
  if (record.test?.file !== profile.file || record.test.fullName !== profile.fullName) throw new Error('stale/ambiguous test binding');
  if (Object.entries(REQUIRED_ROUTE).some(([key, value]) => record.execution[key] !== value)) throw new Error('optional-only execution cannot satisfy required route');
  const entries = inventory.filter((row) => row.file === profile.file);
  if (entries.length !== 1 || !entries[0].execution.some((route) => route.lane === REQUIRED_ROUTE.lane && route.cadence === 'required')) {
    throw new Error('missing file or required execution in current test inventory');
  }
  const assigned = shards.filter((shard) => shard.files.includes(profile.file.replace('packages/agent/', '')));
  if (assigned.length !== 1 || assigned[0].config !== REQUIRED_ROUTE.config || assigned[0].inventory !== 'unit') throw new Error('test is not in exactly one required agent unit shard');
  const matches = discovered.filter((row) => row.file === profile.file && row.name === profile.discoveryName);
  if (matches.length !== 1) throw new Error('missing, ambiguous or undiscovered named assertion');
  if (!['unproven', 'proven'].includes(record.proof?.status) || record.proof.method !== 'historical-replay') throw new Error('invalid proof status/method');
  return { ...profile, shard: assigned[0].index, report: assigned[0].report };
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
    const phases = receipt.phases.filter((phase) => phase.side === side);
    if (phases.length !== 5 || phases.map((phase) => phase.name).join(',') !== 'pnpm-version,install,build,discovery,execution'
        || phases.slice(0, 4).some((phase) => phase.code !== 0 || phase.signal || phase.timedOut)) throw new Error('missing successful prerequisites');
    const execution = phases.at(-1);
    const stdout = fs.readFileSync(inside(root, `${directory}/${side}-execution.log`), 'utf8');
    const observed = inspectExecution(json(inside(root, `${directory}/${side}-report.json`)), { ...execution, stdout }, profile, receipt[side].reportRoot, side);
    if (observed.runtime !== receipt.toolchain.node) throw new Error('test/proof runtime mismatch');
  }
}
export function validateRegressions(root, inventory, { records = loadRecords(root), discover, shards } = {}) {
  if (!records.length) throw new Error('empty regression register');
  const ids = records.map(({ record }) => record.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate case IDs');
  const profiles = records.map(({ record }) => profileFor(record));
  for (const profile of profiles) {
    const source = fs.readFileSync(inside(root, profile.file), 'utf8');
    // Registered assertions must execute even when general test debt has a waiver.
    const analysis = analyzeTestSource(source, profile.file, { applyWaivers: false });
    if (analysis.disabled.length || analysis.focused.length) throw new Error(`${profile.file}: disabled or focused regression test`);
  }
  const assigned = shards ?? planAgentShards(root);
  const discovered = discover ? discover(profiles) : (() => {
    const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--dir', 'packages/agent', 'exec', 'vitest', 'list',
      '--config', REQUIRED_ROUTE.config, ...profiles.map((profile) => profile.file.replace('packages/agent/', '')), '--json'],
    { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`regression discovery failed: ${result.error?.message ?? result.stderr}`);
    return JSON.parse(result.stdout).map((row) => ({ ...row, file: path.relative(root, row.file).split(path.sep).join('/') }));
  })();
  return records.map(({ file, record }) => {
    const profile = validateRecord(record, file, inventory, discovered, assigned);
    validateEvidence(root, record, profile);
    return { id: record.id, proof: record.proof.status, lane: REQUIRED_ROUTE.lane, config: REQUIRED_ROUTE.config,
      shard: profile.shard, report: profile.report, assertion: profile.fullName };
  });
}

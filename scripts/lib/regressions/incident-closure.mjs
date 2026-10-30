import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inside, sha256 } from './identity.mjs';
import { REQUIRED_ROUTE, withDerivedNames } from './profile-contract.mjs';
import { namedTestDiscoveryInvocation, discoverNamedTests } from './named-test-discovery.mjs';
import { validateDetectorEligibility } from './detector-eligibility.mjs';
import { planAgentShards } from '../../ci/plan-agent-shards.mjs';
function bytes(root, file) {
  assert.ok(typeof file === 'string' && file && !file.includes('..') && !path.isAbsolute(file) && !file.includes('\\'), 'unsafe incident evidence path');
  return fs.readFileSync(inside(root, file));
}
function bound(root, descriptor) {
  const raw = bytes(root, descriptor.file);
  assert.equal(sha256(raw), descriptor.sha256, `stale incident evidence: ${descriptor.file}`);
  return raw;
}
const detectorFiles = records => records.flatMap(row => row.detectors.map(detector => detector.file));
export function incidentDiscoveryInvocation(records) {
  return namedTestDiscoveryInvocation(detectorFiles(records));
}
export function discoverIncidentTests(root, records) {
  return discoverNamedTests(root, detectorFiles(records));
}
// Keep release selection with the register, so callers automatically include
// subsequent retrospectives while nested proof reports remain evidence only.
export function loadIncidentRecords(root) {
  const directory = inside(root, 'test-policy/incidents');
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^release-.+\.json$/.test(entry.name))
    .map(entry => entry.name).sort().flatMap(file => {
      const records = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
      assert.ok(Array.isArray(records) && records.length, `empty or invalid incident register: ${file}`);
      return records;
    });
}
export function validateIncidentClosure(root, records, inventory, { discover = discoverIncidentTests, shards } = {}) {
  assert.ok(Array.isArray(records) && records.length, 'empty incident register');
  assert.equal(new Set(records.map(row => row.id)).size, records.length, 'duplicate incident');
  const discovered = discover(root, records);
  const assigned = shards ?? planAgentShards(root);
  return records.map(record => {
    assert.match(record.id, /^GH-\d+$/);
    for (const field of ['owner', 'invariant', 'scope']) assert.ok(typeof record[field] === 'string' && record[field].trim(), 'missing incident context');
    assert.ok(Array.isArray(record.affectedVersions) && record.affectedVersions.length && record.affectedVersions.every(value => typeof value === 'string' && value.trim()), 'missing affected versions');
    assert.ok(Array.isArray(record.links) && record.links.length && record.links.every(link => /^https:\/\/github\.com\/OriginTrail\/dkg\/(issues|pull)\/\d+$/.test(link)), 'missing source links');
    assert.ok(['regression','older-defect','unknown'].includes(record.classification), 'invalid incident classification');
    assert.ok(['open','detector-proven'].includes(record.status), 'invalid incident status');
    assert.ok(Array.isArray(record.detectors) && record.detectors.length, 'missing detector binding');
    for (const detector of record.detectors) {
      assert.ok(typeof detector.suite === 'string' && detector.suite.trim()
        && typeof detector.title === 'string' && detector.title.trim(), 'missing detector suite/title');
      assert.equal(detector.lane, REQUIRED_ROUTE.lane, 'detector declares another execution lane');
      validateDetectorEligibility(root, withDerivedNames(detector), inventory, discovered, assigned);
    }
    if (record.status === 'open') {
      assert.ok(record.gap && !record.proof, 'open incident needs an explicit proof gap');
      return { id: record.id, status: 'open', classification: record.classification, gap: record.gap };
    }
    const proof = JSON.parse(bound(root, record.proof));
    assert.equal(proof.schemaVersion, 1); assert.equal(proof.id, record.id); assert.equal(proof.method, 'guard-mutation');
    assert.match(proof.sourceCommit, /^[a-f0-9]{40}$/);
    const production = bound(root, proof.production).toString(); bound(root, proof.test);
    assert.ok(proof.mutation.old && proof.mutation.old !== proof.mutation.new
      && production.split(proof.mutation.old).length === 2, 'mutation no longer identifies one production guard');
    assert.ok(record.detectors.some(row => row.file === proof.test.file && proof.test.fullName === withDerivedNames(row).fullName), 'proof tests another detector');
    for (const side of ['red','green']) {
      const report = JSON.parse(bound(root, proof[side]));
      assert.equal(report.assertions.length, 1, 'proof must execute exactly the selected test');
      const observed = report.assertions[0];
      assert.equal(observed.fullName, proof.test.fullName, 'proof assertion mismatch');
      assert.equal(observed.status, side === 'red' ? 'failed' : 'passed', 'wrong proof outcome');
      if (side === 'red') {
        assert.notEqual(report.exitCode, 0);
        assert.ok(observed.failureMessages.some(text => text.includes('AssertionError')), 'red was not a behavioral assertion');
      } else { assert.equal(report.exitCode, 0); assert.deepEqual(observed.failureMessages, []); }
      assert.ok(report.command.includes(REQUIRED_ROUTE.config) && report.command.includes(proof.test.file.replace('packages/agent/', ''))
        && report.command.includes('run') && report.command.includes('vitest'), 'proof is not the required unit config/test');
    }
    return { id: record.id, status: 'detector-proven', classification: record.classification, scope: record.scope };
  });
}

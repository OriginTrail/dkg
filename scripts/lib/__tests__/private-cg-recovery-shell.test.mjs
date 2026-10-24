import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.resolve(HERE, '../../devnet-test-private-cg-membership-recovery.sh');

function integrityValidatorSource(harness) {
  const functionStart = harness.indexOf('validate_integrity_data_response() {');
  const functionEnd = harness.indexOf('\n}\n\nvm_integrity_data_query()', functionStart);
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  const body = harness.slice(functionStart, functionEnd);
  const scriptStart = body.indexOf("node -e '\n") + "node -e '\n".length;
  const scriptEnd = body.lastIndexOf("\n  '");
  assert.ok(scriptStart > 0 && scriptEnd > scriptStart);
  return body.slice(scriptStart, scriptEnd);
}

test('private-CG integrity validator canonicalizes standards-shaped SPARQL bindings', () => {
  const harness = fs.readFileSync(HARNESS, 'utf8');
  const validator = integrityValidatorSource(harness);
  const bindings = [
    {
      s: { type: 'uri', value: 'urn:entity:one' },
      p: { type: 'uri', value: 'urn:predicate:value' },
      o: { type: 'literal', value: 'line\n"quoted"', 'xml:lang': 'en' },
    },
    {
      s: { type: 'bnode', value: 'b0' },
      p: { type: 'uri', value: 'urn:predicate:number' },
      o: {
        type: 'typed-literal',
        value: '42',
        datatype: 'http://www.w3.org/2001/XMLSchema#integer',
      },
    },
  ];
  const canonical = [
    ['urn:entity:one', 'urn:predicate:value', '"line\\n\\"quoted\\""@en', ''],
    ['_:b0', 'urn:predicate:number', '"42"^^<http://www.w3.org/2001/XMLSchema#integer>', ''],
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const expectedDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical)).digest('hex')}`;
  const result = spawnSync(process.execPath, ['-e', validator], {
    input: JSON.stringify({ results: { bindings } }),
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPECTED: JSON.stringify({ triplesExpected: 2, publicQuadsDigest: expectedDigest }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    publicTripleCount: 2,
    publicQuadsDigest: expectedDigest,
  });
});

test('testnet health restart allowances apply only to executed restart phases', () => {
  const harness = fs.readFileSync(HARNESS, 'utf8');
  const helperStart = harness.indexOf('audit_testnet_health_samples() {');
  const helperEnd = harness.indexOf('\n}\n\naudit_node_health()', helperStart);
  const helper = harness.slice(helperStart, helperEnd);
  assert.match(helper, /restart_nodes="\$\*"/);
  assert.match(helper, /RESTART_NODES="\$restart_nodes"/);

  const preflightStart = harness.indexOf('sample_node_health preflight');
  const preflightEnd = harness.indexOf('save_artifact "preflight-health-audit.json"', preflightStart);
  const preflight = harness.slice(preflightStart, preflightEnd);
  assert.match(preflight, /audit_testnet_health_samples 2>&1/);
  assert.doesNotMatch(preflight, /audit_testnet_health_samples "\$CURATOR_NODE"/);

  const finalAuditStart = harness.indexOf('audit_node_health() {');
  const finalAuditEnd = harness.indexOf('\n}\n', finalAuditStart);
  const finalAudit = harness.slice(finalAuditStart, finalAuditEnd);
  assert.match(
    finalAudit,
    /audit_testnet_health_samples "\$CURATOR_NODE" "\$JOINER_NODE" 2>&1/,
  );
});

/** Exercise the actual native engine in a separate credential-free fixture instance. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { componentRegistry, normalizeComponentInput } from './component-registry.mjs';
import { collectN8nExecutionResult } from '../../packages/cli/dist/semantic-runtime-n8n-results.js';

const state = resolve(process.argv[2] ?? '');
const origin = new URL(process.argv[3] ?? 'http://127.0.0.1:45780');
if (!process.argv[2] || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new Error('Supply an isolated local fixture state and loopback URL.');
const manifest = JSON.parse(readFileSync(join(state, 'components.json'), 'utf8'));
if (manifest.components.some(c => c.descriptor.connection && c.enabled)) throw new Error('This verifier requires a credential-free fixture, never the owned Google instance.');
const require = createRequire(process.argv[4] ?? '/private/tmp/dkg-n8n-runtime-20261023/node_modules/n8n/package.json');
const { parse } = require('flatted');
const db = new DatabaseSync(join(state, 'n8n/.n8n/database.sqlite'), { readOnly: true });
const evidence = [];
const skipHttp = process.argv.includes('--skip-http');
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1].split(',') : null;
try {
  for (const descriptor of componentRegistry.filter(c => !c.connection && c.mode !== 'schedule' && (!skipHttp || c.id !== 'http-request') && (!only || only.includes(c.id)))) {
    const selected = manifest.components.find(c => c.descriptor.id === descriptor.id);
    let items = descriptor.sampleItems;
    if (descriptor.id === 'remove-duplicates') items = [...items, { name: 'Ana', value: 99, active: false }];
    if (descriptor.inputs === 2) items = [{ _input: 0, name: 'Ana', value: 1 }, { _input: 0, name: 'Luka', value: 2 },
      { _input: 1, name: 'Ana', value: 1 }, { _input: 1, name: 'Bojan', value: 3 }];
    const input = normalizeComponentInput(descriptor, { itemsJson: JSON.stringify(items), paramsJson: '{}' });
    const response = await fetch(new URL('/webhook/dkg-capability-' + selected.grant.workflowId, origin), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invocationId: 'native-fixture-' + descriptor.id, input }), signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200, descriptor.id);
    const ack = await response.json(); assert.match(ack.executionId, /^\d+$/, descriptor.id);
    let execution;
    for (let attempt = 0; attempt < 150; attempt++) {
      const row = db.prepare('SELECT e.status,d.data,e.workflowVersionId,d.workflowData FROM execution_entity e LEFT JOIN execution_data d ON d.executionId=e.id WHERE e.id=?').get(ack.executionId);
      if (row && row.data && !['new', 'running', 'waiting'].includes(row.status)) {
        execution = { id: ack.executionId, workflowId: selected.grant.workflowId, status: row.status,
          workflowVersionId: row.workflowVersionId, workflowData: JSON.parse(row.workflowData), data: parse(row.data) };
        break;
      }
      await delay(100);
    }
    assert.ok(execution, descriptor.id + ' did not finish.');
    const result = collectN8nExecutionResult(selected.grant, execution);
    const output = JSON.parse(result.itemsJson), ports = JSON.parse(result.portsJson);
    const rejected = descriptor.mode === 'stop';
    if (result.ok !== !rejected) {
      const errors = Object.entries(execution.data.resultData.runData).flatMap(([node, runs]) => runs.filter(r => r.error).map(r => ({ node, message: r.error.message, description: r.error.description })));
      console.log(JSON.stringify({ failed: descriptor.id, executionId: ack.executionId, errors }));
    }
    assert.equal(result.ok, !rejected, descriptor.id);
    switch (descriptor.id) {
      case 'edit-fields': assert.equal(output[0].team, 'DKG'); break;
      case 'filter': assert.deepEqual(output.map(x => x.name), ['Ana']); break;
      case 'sort': assert.equal(output[0].value, 7); break;
      case 'limit': assert.equal(output.length, 1); break;
      case 'remove-duplicates': assert.equal(output.length, 2); break;
      case 'split-out': assert.equal(output.length, 2); break;
      case 'aggregate': assert.equal(output[0].items.length, 2); break;
      case 'summarize': assert.ok(Object.values(output[0]).includes(19)); break;
      case 'rename-keys': assert.equal(output[0].fullName, 'Ana'); assert.ok(!Object.hasOwn(output[0], 'name')); break;
      case 'date-time': assert.equal(output[0].formattedDate, '2026-10-23'); break;
      case 'extract-file': assert.equal(output.length, 2); assert.equal(output[0].name, 'Ana'); break;
      case 'convert-file': assert.ok(Buffer.from(output[0].file.base64, 'base64').toString().includes('Ana')); break;
      case 'xml': assert.ok(JSON.stringify(output).includes('Ana')); break;
      case 'html': assert.equal(output[0].text, 'Hello DKG'); break;
      case 'markdown': assert.ok(output[0].html.includes('<h1')); break;
      case 'crypto': assert.equal(output[0].hash, createHash('sha256').update('Ana').digest('hex')); break;
      case 'compression': assert.equal(Buffer.from(output[0].file.base64, 'base64').subarray(0, 2).toString(), 'PK'); break;
      case 'http-request': assert.equal(typeof output[0].current.temperature_2m, 'number'); break;
      case 'if': assert.equal(ports.true[0].name, 'Ana'); assert.equal(ports.false[0].name, 'Luka'); break;
      case 'switch': assert.equal(ports.match[0].name, 'Ana'); assert.equal(ports.other[0].name, 'Luka'); break;
      case 'merge': assert.equal(output.length, 4); break;
      case 'compare-datasets': assert.equal(ports.same.length, 1); assert.equal(ports['only-a'].length, 1); assert.equal(ports['only-b'].length, 1); break;
      case 'loop-items': assert.equal(ports.done.length, 2); break;
      case 'execute-workflow': assert.equal(output[0].name, 'Ana'); break;
      case 'wait': case 'webhook': assert.equal(output.length, 2); break;
    }
    evidence.push({ component: descriptor.id, executionId: ack.executionId, status: execution.status, expectedRejection: rejected,
      verified: true, outputHash: createHash('sha256').update(JSON.stringify(result)).digest('hex') });
    const evidenceFile = join(state, 'native-component-evidence.json');
    let previous = []; try { previous = JSON.parse(readFileSync(evidenceFile, 'utf8')).components; } catch {}
    writeFileSync(evidenceFile, JSON.stringify({ fixtureOnly: true, components: [...previous.filter(c => c.component !== descriptor.id), evidence.at(-1)], googleCredentialsUsed: false }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(evidence.at(-1)));
  }
  console.log(JSON.stringify({ verifiedNativeComponents: evidence.length, credentialsUsed: false }));
} finally { db.close(); }

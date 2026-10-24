/** Real native HTTP + mapping, using only the credential-free fixture instance. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { component } from './component-registry.mjs';
import { compileStudio } from './studio-definition.mjs';
import { collectN8nExecutionResult } from '../../packages/cli/dist/semantic-runtime-n8n-results.js';

const state = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Supply the credential-free fixture state.');
const manifest = JSON.parse(readFileSync(join(state, 'components.json'), 'utf8'));
if (manifest.components.some(c => c.descriptor.connection && c.enabled)) throw new Error('Never run this fixture against a Google-connected instance.');
const url = 'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m,wind_speed_10m&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m';
const fixtures = ['weather', 'query'].map((name, index) => {
  const definition = { id: `00000000-0000-4000-8000-00000000007${index}`, name: 'Generic HTTP native fixture ' + name, entryId: 'request',
    nodes: ['http-request', 'edit-fields'].map((id, i) => ({ id: i ? 'mapping' : 'request', componentId: id,
      kaRef: manifest.components.find(c => c.descriptor.id === id && !c.retired).kaRef, sourceHash: 'a'.repeat(64),
      params: Object.fromEntries(Object.entries(component(id).parameters).map(([k, s]) => [k, s.default])), x: 40 + i * 250, y: 100 })),
    edges: [{ from: 'request', output: 0, to: 'mapping', input: 0 }] };
  definition.nodes[0].params.url = index ? 'https://api.open-meteo.com/v1/forecast' : url;
  if (index) Object.assign(definition.nodes[0].params, {
    query: { latitude: '{{ $json.location.latitude }}', longitude: '{{ $json.location.longitude }}', current: 'temperature_2m', hourly: 'temperature_2m' },
    headers: { 'X-DKG-PoC': 'generic-input' },
  });
  definition.nodes[1].params = { keepInput: 'no', fields: { temperature: '{{ $json.current.temperature_2m }}', unit: '{{ $json.current_units.temperature_2m }}',
    time: '{{ $json.current.time }}', ...(index ? { firstHourly: '{{ $json.hourly.temperature_2m[0] }}' } : {}) } };
  return { name, input: index ? [{ location: { latitude: 52.52, longitude: 13.41 } }] : [{}],
    ...compileStudio(definition, { graphId: 'n8n-capability-poc', owner: '0x' + '1'.repeat(40), fixture: true, providerId: 'studio_generic_http_' + name + '_v2' }) };
});
if (process.argv.includes('--prepare')) {
  const directory = join(state, 'generic-http-fixtures'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const f of fixtures) writeFileSync(join(directory, f.workflowId + '.json'), JSON.stringify({ ...f.workflow, id: f.workflowId, versionId: randomUUID() }), { mode: 0o600 });
  console.log(JSON.stringify({ prepared: fixtures.length, directory, ids: fixtures.map(f => f.workflowId) }));
} else {
  const require = createRequire('/private/tmp/dkg-n8n-runtime-20261023/node_modules/n8n/package.json'), { parse } = require('flatted');
  const db = new DatabaseSync(join(state, 'n8n/.n8n/database.sqlite'), { readOnly: true });
  const evidence = [];
  try {
    for (const f of fixtures) {
      const response = await fetch('http://127.0.0.1:45780/webhook/dkg-capability-' + f.workflowId, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: { itemsJson: JSON.stringify(f.input), paramsJson: JSON.stringify(f.definition.nodes[0].params), executionId: '' } }), signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200); const ack = await response.json(); let execution;
      for (let attempt = 0; attempt < 150; attempt++) {
        const row = db.prepare('SELECT e.status,d.data FROM execution_entity e JOIN execution_data d ON d.executionId=e.id WHERE e.id=?').get(ack.executionId);
        if (row && !['new', 'running', 'waiting'].includes(row.status)) { execution = { status: row.status, data: parse(row.data) }; break; }
        await delay(100);
      }
      assert.ok(execution, 'HTTP fixture did not finish');
      if (execution.status !== 'success') console.log(JSON.stringify({ error: execution.data.resultData.error?.message, node: execution.data.resultData.lastNodeExecuted }));
      const output = collectN8nExecutionResult(f.grant, execution);
      assert.equal(output.ok, true, output.error);
      const rows = JSON.parse(output.itemsJson), trace = JSON.parse(output.traceJson);
      assert.equal(rows.length, 1); assert.equal(typeof rows[0].temperature, 'number'); assert.equal(rows[0].unit, '°C');
      assert.match(rows[0].time, /^\d{4}-\d{2}-\d{2}T/); assert.equal(trace.length, 2); assert.ok(trace.every(v => v.status === 'completed'));
      assert.equal(Object.hasOwn(rows[0], 'hourly'), false);
      if (f.name === 'query') assert.equal(typeof rows[0].firstHourly, 'number');
      evidence.push({ name: f.name, executionId: ack.executionId, output: rows[0], nativeNodeTypes: f.workflow.nodes.filter(n => ['Block request', 'Block mapping'].includes(n.name)).map(n => n.type), workflowSha256: f.grant.workflowSha256 });
      console.log(JSON.stringify(evidence.at(-1)));
    }
    writeFileSync(join(state, 'native-http-mapping-evidence.json'), JSON.stringify({ fixtureOnly: true, evidence }, null, 2), { mode: 0o600 });
  } finally { db.close(); }
}

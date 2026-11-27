import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GraphComputer } from '../../packages/graph-computer/dist/index.js';

const { Wallet } = createRequire(new URL('../../packages/graph-computer/package.json', import.meta.url))('ethers');
const state = resolve(process.argv[2]);
const connection = JSON.parse(readFileSync(join(state, 'client.json'), 'utf8'));
const { components } = JSON.parse(readFileSync(join(state, 'csv-components.json'), 'utf8'));
const parse = components.find(c => c.kind === 'csv-parse'), map = components.find(c => c.kind === 'csv-map');
assert.ok(parse?.enabled && map?.enabled, 'Install the CSV components first');
const signer = new Wallet(readFileSync(connection.keyFile, 'utf8').trim());
const client = new GraphComputer({ nodeUrl: connection.nodeUrl, peerId: connection.peerId, signer, retries: 0 });
const graphId = connection.graphId;
const revision = createHash('sha256').update(parse.kaRef + '\n' + map.kaRef).digest('hex').slice(0, 12);
const programIri = 'urn:demo:n8n:csv-pipeline:' + revision;
let stored;
try { stored = await client.programs.getSource({ graphId, programIri, programLayer: 'wm' }); }
catch (e) { if (e.code !== 'PROGRAM_NOT_FOUND') throw e; }
const program = stored ? { graphId, programIri, programLayer: 'wm', authorAgentAddress: stored.authorAgentAddress, sourceHash: stored.sourceHash }
  : await client.programs.upload({ graphId, programIri, name: 'csv-pipeline-v1', label: 'Compose CSV parser and mapper KAs',
    language: 'typescript-v1', requiredTools: [], permittedPrograms: [parse.kaRef, map.kaRef],
    source: `import { invoke_program } from '@origintrail-official/dkg-graph-computer/program';
export async function run(input: { csv: string; mapping: { source: number; target: string }[] }) {
  const parsed = await invoke_program('${parse.kaRef}', [{ csv: input.csv }]) as { output: { ok: boolean; columns: string[]; rows: string[][]; error: string } };
  if (!parsed.output.ok) throw new Error(parsed.output.error);
  return invoke_program('${map.kaRef}', [{ columns: parsed.output.columns, rows: parsed.output.rows, mapping: input.mapping }]);
}` });
let approval;
try { approval = await client.programs.getApproval({ graphId, operationIri: programIri }); }
catch (e) { if (e.status !== 404) throw e; }
if (!approval) await client.programs.approve({ graphId, operationIri: programIri, program, allowedCallers: [signer.address],
  typescript: { children: [parse, map].map(c => ({ graphId, operationIri: c.kaRef })), maxCalls: 4, maxConcurrency: 1, timeoutMs: 30000 } });
const file = join(state, 'csv-parent-invocation.json');
const request = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))
  : client.programs.prepareInvocation({ graphId, operationIri: programIri, inputs: [{ csv: 'name,email\nAna,ana@example.com\n', mapping: [{ source: 1, target: 'Email' }] }] });
assert.equal(request.operationIri, programIri, 'Inspect the saved invocation before changing its pinned children');
writeFileSync(file, JSON.stringify(request, null, 2), { mode: 0o600 });
const result = await client.programs.invoke(request);
assert.deepEqual(result.outputs[0].output, { ok: true, columns: ['Email'], rows: [['ana@example.com']], error: '' });
assert.deepEqual(await client.programs.invoke(request), result);
const children = result.trace.calls.filter(call => call.kind === 'program');
assert.equal(children.length, 2); assert.ok(children.every(c => c.executionIri));
const report = { parentKaRef: programIri, parentExecutionIri: result.executionIri, children,
  output: result.outputs[0].output, persisted: result.persisted, replayVerified: true };
writeFileSync(join(state, 'csv-composition-evidence.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

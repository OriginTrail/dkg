import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { GraphComputer } from '../../packages/graph-computer/dist/index.js';
const { Wallet } = createRequire(new URL('../../packages/graph-computer/package.json', import.meta.url))('ethers');
const state = resolve(process.argv[2]);
const connection = JSON.parse(readFileSync(join(state, 'client.json'), 'utf8'));
const signer = new Wallet(readFileSync(connection.keyFile, 'utf8').trim());
const client = new GraphComputer({ nodeUrl: connection.nodeUrl, peerId: connection.peerId, signer, retries: 0 });
const graphId = connection.graphId, programIri = 'urn:demo:n8n:normalize-parent:1';
let stored;
try { stored = await client.programs.getSource({ graphId, programIri, programLayer: 'wm' }); }
catch (error) { if (error.code !== 'PROGRAM_NOT_FOUND') throw error; }
const program = stored
  ? { graphId, programIri, programLayer: 'wm', sourceHash: stored.sourceHash, authorAgentAddress: stored.authorAgentAddress }
  : await client.programs.upload({ graphId, programIri, name: 'normalize-parent-v1', label: 'Normalize text through a child KA',
    language: 'typescript-v1', requiredTools: [], permittedPrograms: [connection.kaRef],
    source: `import { invoke_program } from '@origintrail-official/dkg-graph-computer/program';
export function run(input: unknown) { return invoke_program('${connection.kaRef}', [input]); }` });
let approval;
try { approval = await client.programs.getApproval({ graphId, operationIri: programIri }); }
catch (error) { if (error.status !== 404) throw error; }
if (!approval) await client.programs.approve({ graphId, operationIri: programIri, program, allowedCallers: [signer.address],
  typescript: { children: [{ graphId, operationIri: connection.kaRef }], maxCalls: 2, maxConcurrency: 1, timeoutMs: 30000 } });
const prepared = client.programs.prepareInvocation({ graphId, operationIri: programIri, inputs: [{ text: '  composed dkg  ' }] });
writeFileSync(join(state, 'parent-invocation.json'), JSON.stringify(prepared), { mode: 0o600 });
const result = await client.programs.invoke(prepared);
assert.equal(result.outputs[0].output.text, 'COMPOSED DKG');
assert.deepEqual(await client.programs.invoke(prepared), result);
const child = result.trace?.calls.find(call => call.kind === 'program');
assert.ok(child?.executionIri);
const evidence = { parentKaRef: programIri, parentExecutionIri: result.executionIri, childExecutionIri: child.executionIri,
  n8nExecutionId: result.outputs[0].n8nExecutionId, output: result.outputs[0].output, persisted: result.persisted, replayVerified: true };
writeFileSync(join(state, 'composition-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));

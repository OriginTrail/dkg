import { readFile } from 'node:fs/promises';
import { Wallet } from 'ethers';
import { GraphComputer } from '../../dist/index.js';

function env(name) { if (!process.env[name]) throw new Error(`Set ${name}`); return process.env[name]; }
const ownerSigner = new Wallet((await readFile(env('OWNER_KEY_FILE'), 'utf8')).trim());
const callerSigner = new Wallet((await readFile(env('CALLER_KEY_FILE'), 'utf8')).trim());
const owner = new GraphComputer({ nodeUrl: env('EXECUTOR_URL'), peerId: env('EXECUTOR_PEER_ID'), signer: ownerSigner });
const caller = new GraphComputer({ nodeUrl: env('CLIENT_URL'), peerId: env('CLIENT_PEER_ID'),
  executorPeerId: env('EXECUTOR_PEER_ID'), signer: callerSigner });
const programGraph = env('PROGRAM_GRAPH'), graphId = env('DATA_GRAPH');
const childOperation = { graphId, operationIri: 'urn:example:scale' };
const workflowOperation = { graphId, operationIri: 'urn:example:scaled-total' };

const child = await owner.programs.upload({ graphId: programGraph, programIri: 'urn:example:program:scale:v1',
  language: 'typescript-v1', requiredTools: [], source: await readFile(new URL('./scale.ts', import.meta.url), 'utf8') });
await owner.programs.approve({ ...childOperation, program: child, allowedCallers: [callerSigner.address], typescript: { children: [] } });
const parent = await owner.programs.upload({ graphId: programGraph, language: 'typescript-v1', requiredTools: [],
  permittedPrograms: [child.programIri], source: await readFile(new URL('./workflow.ts', import.meta.url), 'utf8') });
await owner.programs.approve({ ...workflowOperation, program: parent, allowedCallers: [callerSigner.address],
  typescript: { children: [childOperation], maxCalls: 64, maxConcurrency: 4, timeoutMs: 30000 } });
// This signer must be an explicitly configured operator on the client node.
await caller.routes.create({ ...workflowOperation, targetPeerId: env('EXECUTOR_PEER_ID') });
const result = await caller.programs.invoke({ ...workflowOperation, inputs: [[1, 2, 3], 10] });
if (result.outputs.length !== 1 || result.outputs[0] !== 60) throw new Error('Unexpected workflow result');
console.log(JSON.stringify(result, null, 2));

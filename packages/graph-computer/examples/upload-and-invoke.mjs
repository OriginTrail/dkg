import { readFile } from 'node:fs/promises';
import { Wallet } from 'ethers';
import { GraphComputer } from '../dist/index.js';
import { examples } from './programs.mjs';

const required = key => {
  if (!process.env[key]) throw new Error(`Set ${key}`);
  return process.env[key];
};
// Key files stay on this machine. Signers can also be external signing services.
const ownerSigner = new Wallet((await readFile(required('OWNER_KEY_FILE'), 'utf8')).trim());
const callerSigner = new Wallet((await readFile(required('CALLER_KEY_FILE'), 'utf8')).trim());
const executorPeerId = required('EXECUTOR_PEER_ID');
const owner = new GraphComputer({ nodeUrl: required('EXECUTOR_URL'), peerId: executorPeerId, signer: ownerSigner });
const caller = new GraphComputer({ nodeUrl: required('CLIENT_URL'), peerId: required('CLIENT_PEER_ID'), executorPeerId, signer: callerSigner });
const graphId = required('DATA_GRAPH');
const programGraph = required('PROGRAM_GRAPH');

// This explicitly installs approvals and routes and executes a write in scenario 2.
// The caller must be configured as a client-node operator to create these routes.
for (const scenario of examples(graphId)) {
  const program = await owner.programs.upload({ graphId: programGraph, source: scenario.source, requiredTools: scenario.requiredTools });
  const operationIri = `${program.programIri}:operation`;
  const approval = await owner.programs.approve({
    graphId, operationIri, program, allowedCallers: [callerSigner.address],
    sparqlRead: scenario.sparqlRead,
    ...(scenario.assetCreation ? { assetCreation: scenario.assetCreation } : {}),
  });
  await caller.routes.create({ graphId, operationIri, targetPeerId: executorPeerId });
  const invocation = caller.programs.prepareInvocation({ graphId, operationIri });
  // Save this public handle in durable application storage before invoking if needed.
  console.log(JSON.stringify({ scenario: scenario.name, program, approvalRevision: approval.revision, invocation }));
  console.log(JSON.stringify(await caller.programs.invoke(invocation), null, 2));
}

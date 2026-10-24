import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { Wallet } = createRequire(new URL('../../packages/graph-computer/package.json', import.meta.url))('ethers');
import { GraphComputer } from '../../packages/graph-computer/dist/index.js';

const connection = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const client = new GraphComputer({ nodeUrl: connection.nodeUrl, peerId: connection.peerId,
  signer: new Wallet(readFileSync(connection.keyFile, 'utf8').trim()), retries: 0 });
const result = await client.programs.invoke({ graphId: connection.graphId, operationIri: connection.kaRef,
  invocationId: process.argv[4] ?? randomUUID(), inputs: [{ text: process.argv[3] ?? '  hello dkg  ' }] });
console.log(JSON.stringify(result, null, 2));

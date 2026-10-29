import { expect, it } from 'vitest';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { checkpointChainBinding } from '../src/snapshot-checkpoint-edge-session.js';
it('normal chain configuration binds to exactly the EVM adapter deployment without RPC', () => {
  const chain = { rpcUrl: 'http://127.0.0.1:1', chainId: 'base:8453', hubAddress: '0x' + 'AB'.repeat(20), operationalKeys: ['0x' + '11'.repeat(32)] };
  const adapter = new EVMChainAdapter({ ...chain, privateKey: chain.operationalKeys[0], allowNoAdminSigner: true });
  expect(checkpointChainBinding({ dataDir: '/unused', name: 'binding', chainConfig: chain })).toEqual({ chainId: adapter.chainId, deploymentId: adapter.deploymentId });
  expect(() => checkpointChainBinding({ dataDir: '/unused', name: 'binding' })).toThrow('explicit chain');
});

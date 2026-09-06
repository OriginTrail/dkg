import { Command } from 'commander';

import { ApiClient } from '../api-client.js';

export function registerAgentCommand(program: Command): void {
// ─── dkg agent ────────────────────────────────────────────────────────
//
// Manage workspace-encryption keys for local DKG agents. The `register` /
// `identity` / `list` surfaces are still exposed via the bare `/api/agent/*`
// HTTP routes for backward compatibility; this umbrella focuses on the
// rotate / revoke flows added with multi-key SWM encryption.

const agentCmd = program
  .command('agent')
  .description('Manage local DKG agents (encryption-key rotation + revocation)');

agentCmd
  .command('rotate-encryption-key <agentAddress>')
  .description('Mint a fresh workspace encryption key for a custodial local agent and re-publish its profile')
  .option('--retire-old', 'Also wallet-sign + publish a revocation for the previous default key in the same operation', false)
  .action(async (agentAddress: string, opts: { retireOld?: boolean }) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.rotateAgentEncryptionKey(agentAddress, { retireOld: !!opts.retireOld });
      console.log(`New encryption key:    ${result.newKeyId}`);
      if (result.retiredKeyId) {
        console.log(`Retired (revoked) key: ${result.retiredKeyId}`);
      } else {
        console.log('Previous key remains ACTIVE — call `dkg agent revoke-encryption-key <agent> <key>` once propagation has settled.');
      }
      if (result.profilePublished) {
        console.log('Profile re-published:  yes');
      } else if (result.profilePublishError) {
        console.error('Profile re-published:  NO — ' + result.profilePublishError);
        if (result.retiredKeyId) {
          console.error('Peers will keep encrypting to the retired key until republish succeeds.');
          console.error('Retry with: `dkg agent publish-profile` (or POST /api/agent/publish-profile with a node-admin token).');
        } else {
          console.error('The new key is persisted locally; peers will pick it up on the next agent-registry sync.');
        }
        process.exit(1);
      } else {
        console.log('Profile re-published:  skipped (agent is not this node\'s default profile)');
      }
    } catch (err: any) {
      console.error(`Rotation failed: ${err?.message ?? err}`);
      process.exit(1);
    }
  });

agentCmd
  .command('publish-profile')
  .description('Re-publish the daemon\'s default agent profile (retry endpoint for failed rotate/revoke republish)')
  .action(async () => {
    try {
      const client = await ApiClient.connect();
      const result = await client.publishAgentProfile();
      console.log('Profile re-published.');
      if (result.ual) console.log(`UAL: ${result.ual}`);
    } catch (err: any) {
      console.error(`Publish failed: ${err?.message ?? err}`);
      process.exit(1);
    }
  });

agentCmd
  .command('revoke-encryption-key <agentAddress> <keyId>')
  .description('Wallet-sign and publish a revocation for a specific workspace encryption key (refuses to revoke the last active key)')
  .action(async (agentAddress: string, keyId: string) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.revokeAgentEncryptionKey(agentAddress, keyId);
      console.log(`Revoked: ${result.revokedKeyId}`);
      console.log(`At:      ${result.revokedAt}`);
      if (result.profilePublished) {
        console.log('Profile re-published: yes');
      } else if (result.profilePublishError) {
        console.error('Profile re-published: NO — ' + result.profilePublishError);
        console.error('Peers will keep encrypting to the revoked key until republish succeeds.');
        console.error('Retry with: `dkg agent publish-profile` (or POST /api/agent/publish-profile with a node-admin token).');
        process.exit(1);
      } else {
        // Non-default agent: the revocation is recorded locally but the daemon's
        // single-profile publishProfile() doesn't cover this agent. Operator
        // must republish through whichever channel hosts that agent's profile.
        console.error('Profile re-published: skipped (agent is not this node\'s default profile)');
        console.error('Peers may keep encrypting to the revoked key until that agent\'s profile is independently republished.');
        process.exit(1);
      }
    } catch (err: any) {
      console.error(`Revocation failed: ${err?.message ?? err}`);
      process.exit(1);
    }
  });
}

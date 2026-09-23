import { Command } from 'commander';
import { toErrorMessage } from '@origintrail-official/dkg-core';
import { ApiClient } from '../api-client.js';
import { formatProfileNodeIdStatus } from '../profile-node-id-wire.js';

/**
 * `dkg identity` — this node's on-chain identity.
 *
 *   dkg identity node-id        the Profile nodeId next to this node's peer id
 *   dkg identity sync-node-id   set the nodeId to this node's peer id
 *
 * The nodeId is how peers map an on-chain identity (a sharding-table member,
 * an ACK signer) to a dialable libp2p peer. Profiles created before this
 * release carry random bytes there; Profile >= 10.1.0 lets the identity fix it.
 */
export function registerIdentityCommand(program: Command): void {
  const identity = program
    .command('identity')
    .description("Inspect and maintain this node's on-chain identity");

  identity
    .command('node-id')
    .description("Show the on-chain Profile nodeId and whether it names this node's libp2p peer id")
    .option('--json', 'Print the raw /api/identity/node-id response')
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = await ApiClient.connect();
        const status = await client.getProfileNodeIdStatus();
        if (opts.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        for (const line of formatProfileNodeIdStatus(status)) console.log(line);
      } catch (err) {
        console.error(toErrorMessage(err));
        process.exit(1);
      }
    });

  identity
    .command('sync-node-id')
    .description(
      "Set the on-chain Profile nodeId to this node's libp2p peer id (needs Profile >= 10.1.0; " +
      'signed by the operational key, or the admin key if only that is accepted)',
    )
    .option('--json', 'Print the raw /api/identity/node-id/sync response')
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = await ApiClient.connect();
        const result = await client.syncProfileNodeId();
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.message);
          if (result.txHash) console.log(`  tx: ${result.txHash}${result.signer ? ` (signed by ${result.signer})` : ''}`);
        }
        if (result.outcome !== 'updated' && result.outcome !== 'in-sync') process.exit(1);
      } catch (err) {
        console.error(toErrorMessage(err));
        process.exit(1);
      }
    });
}

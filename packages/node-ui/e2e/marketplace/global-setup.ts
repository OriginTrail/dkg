/**
 * The marketplace lane's global setup, run once every web server is up (the
 * devnet and the marketplace among them, see `bootstrap.ts`).
 *
 * A seller lands receipts only in an epoch in which its node has a score, and
 * a Core Node earns one by proving a Knowledge Asset that random sampling
 * challenges it with; with no published asset there is no challenge. So one
 * asset is published to Verifiable Memory here, through the default suite's
 * WM → SWM → VM pipeline, early enough for the seller to be scored by the time
 * the Operate spec lands.
 */
import { waitForConnectedPeers } from '../helpers/devnet.js';
import { PRIMARY_CG, seedVmEntity } from '../helpers/real-node.js';
import { readSetup } from './devnet.js';
import { NODES, NUM_NODES } from './topology.js';

export default async function globalSetup(): Promise<void> {
  const setup = readSetup();
  console.log(`[marketplace] seller ${setup.seller.identityId} on node${setup.seller.node}, buyer on node${setup.buyer.node}, "${setup.contextGraphId}" on chain as ${setup.onChainId}`);
  await waitForConnectedPeers(NODES.owner, NUM_NODES - 1, 120_000);
  const seeded = await seedVmEntity(PRIMARY_CG, NODES.owner);
  console.log(`[marketplace] published "${seeded.label}" to ${PRIMARY_CG} for random sampling (kaId=${seeded.kaId ?? 'n/a'})`);
}

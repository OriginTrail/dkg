import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { ethers } from 'ethers';
import { toErrorMessage } from '@origintrail-official/dkg-core';
import { ApiClient } from '../api-client.js';
import type {
  MarketplaceMeterStateWire,
  MarketplaceOfferingWire,
  MarketplacePlanPolicyWire,
  MarketplaceServiceTypeWire,
  MarketplaceSettleActionWire,
} from '../api-client-marketplace.js';

// ─── dkg marketplace — OT-RFC-27 marketplace operator surface ─────────
//
// Thin wrappers over the daemon's /api/marketplace routes (see
// daemon/routes/marketplace.ts). Buyer writes (subscribe, invoke) and seller
// writes (offerings, settle) are node-admin-gated by the daemon; status,
// offers and meter are open reads. All wei values travel as decimal strings.

const SERVICE_TYPES: readonly MarketplaceServiceTypeWire[] = ['inference', 'query', 'reasoning', 'graph-ml'];
const SETTLE_ACTIONS: readonly MarketplaceSettleActionWire[] = ['flush-receipts', 'finalize', 'claim', 'roll'];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function loadJsonFile<T>(path: string, what: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch (err) {
    return fail(`Failed to read ${what} from ${path}: ${toErrorMessage(err)}`);
  }
}

function tracLine(wei: string): string {
  try {
    return `${ethers.formatEther(wei)} TRAC (${wei} wei)`;
  } catch {
    return `${wei} wei`;
  }
}

function printMeterState(state: MarketplaceMeterStateWire | undefined, summary: string | undefined): void {
  if (summary !== undefined) console.log(`  Meter:     ${summary}`);
  if (!state) return;
  console.log(`  Budget:    ${tracLine(state.totalBudgetWei)} (soft ceiling ${state.softCeilingBps} bps)`);
  console.log(`  Settled:   ${tracLine(state.totalSettledWei)}`);
  console.log(`  Reserved:  ${tracLine(state.totalReservedWei)}`);
  state.buckets.forEach((bucket, index) => {
    console.log(
      `  Bucket ${index}:  budget ${tracLine(bucket.budgetWei)}, settled ${tracLine(bucket.settledWei)}, reserved ${tracLine(bucket.reservedWei)}`,
    );
  });
}

export function registerMarketplaceCommand(program: Command): void {
// ─── dkg marketplace (alias: mkt) ─────────────────────────────────────

const marketplaceCmd = program
  .command('marketplace')
  .alias('mkt')
  .description('OT-RFC-27 marketplace: offers, subscriptions, metered invokes, settlement');

marketplaceCmd
  .command('status')
  .description('Show the marketplace runtime snapshot (roles, epoch, meter, pending receipts)')
  .option('--json', 'Print the raw JSON response instead of the formatted summary')
  .action(async (opts: { json?: boolean }) => {
    try {
      const client = await ApiClient.connect();
      const status = await client.marketplace.status();
      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(`  Marketplace: ${status.enabled ? 'enabled' : 'disabled'}`);
      console.log(`  Seller:      ${status.sellerReady ? 'ready' : 'off'}`);
      console.log(`  Buyer:       ${status.buyerReady ? 'ready' : 'off'}`);
      if (status.epoch !== undefined) console.log(`  Epoch:       ${status.epoch}`);
      if (status.settlementDeadline !== undefined) {
        console.log(`  Settles:     ${status.settlementDeadline} (unix seconds, receipts accepted until then)`);
      }
      if (status.seller) {
        console.log(`  Offerings:   ${status.seller.offerings} (pending receipts: ${status.seller.pendingReceipts}, submitted claims: ${status.seller.submittedClaims})`);
      }
      if (status.buyer) {
        console.log(`  Subscribed:  ${status.buyer.subscribed}${status.buyer.epoch !== undefined ? ` (epoch ${status.buyer.epoch})` : ''}`);
        if (status.buyer.sessionKeyAddress) console.log(`  Session key: ${status.buyer.sessionKeyAddress}`);
        printMeterState(status.buyer.meter, undefined);
      }
    } catch (err) {
      fail(toErrorMessage(err));
    }
  });

marketplaceCmd
  .command('offers')
  .description('List offers discovered in the local view of the `marketplace` Context Graph')
  .option('--json', 'Print the raw JSON response instead of the formatted list')
  .action(async (opts: { json?: boolean }) => {
    try {
      const client = await ApiClient.connect();
      const { offers, count } = await client.marketplace.offers();
      if (opts.json) {
        console.log(JSON.stringify({ offers, count }, null, 2));
        return;
      }
      if (count === 0) {
        console.log('No offers discovered (is the marketplace Context Graph synced?)');
        return;
      }
      for (const offer of offers) {
        console.log(`${offer.offerId}`);
        console.log(`  service:  ${offer.serviceType}${offer.modelId ? ` (${offer.modelId})` : ''}`);
        console.log(`  ask:      ${offer.askPerUnitWei} wei per ${offer.unit}`);
        console.log(`  seller:   identity ${offer.sellerIdentityId}, peer ${offer.sellerPeerId}`);
        if (offer.expiresAt !== undefined) console.log(`  expires:  ${offer.expiresAt} (unix seconds)`);
      }
    } catch (err) {
      fail(toErrorMessage(err));
    }
  });

marketplaceCmd
  .command('offerings <file>')
  .description('Set (and by default publish) this node\'s seller offerings from a JSON file '
    + '(an array of offerings, or { "offerings": [...] }; wei fields are decimal strings)')
  .option('--no-publish', 'Serve the offerings without publishing offer KAs to the Context Graph')
  .option('--json', 'Print the raw JSON response')
  .action(async (file: string, opts: { publish: boolean; json?: boolean }) => {
    try {
      const raw = await loadJsonFile<MarketplaceOfferingWire[] | { offerings: MarketplaceOfferingWire[] }>(file, 'offerings');
      const offerings = Array.isArray(raw) ? raw : raw.offerings;
      if (!Array.isArray(offerings)) {
        fail('Offerings file must be a JSON array of offerings or { "offerings": [...] }');
      }
      const client = await ApiClient.connect();
      const result = await client.marketplace.setOfferings({ offerings, publish: opts.publish });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Serving ${result.offerings} offering(s); published ${result.published.length} offer KA(s)`);
      for (const published of result.published) console.log(`  ${published}`);
    } catch (err) {
      fail(toErrorMessage(err));
    }
  });

marketplaceCmd
  .command('subscribe')
  .description('Fund a non-refundable period subscription (one TRAC transfer into the epoch pool) and register the session key')
  .option('--trac <amount>', 'Subscription funding in TRAC (decimal, e.g. 10)')
  .option('--wei <amount>', 'Subscription funding in wei (decimal integer string)')
  .requiredOption('--policy <file>', 'Plan policy JSON file ({ totalBudgetWei, buckets: [...] }; wei fields are decimal strings)')
  .option('--epoch <epoch>', 'Chronos epoch to fund (default: the current epoch)')
  .option('--json', 'Print the raw JSON response')
  .action(async (opts: { trac?: string; wei?: string; policy: string; epoch?: string; json?: boolean }) => {
    try {
      if ((opts.trac === undefined) === (opts.wei === undefined)) {
        fail('Pass exactly one of --trac or --wei');
      }
      const policy = await loadJsonFile<MarketplacePlanPolicyWire>(opts.policy, 'plan policy');
      const client = await ApiClient.connect();
      const result = await client.marketplace.subscribe({
        ...(opts.wei !== undefined ? { amountWei: opts.wei } : { amountTrac: opts.trac as string }),
        ...(opts.epoch !== undefined ? { epoch: opts.epoch } : {}),
        policy,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log('Subscription funded:');
      console.log(`  epoch:       ${result.epoch}`);
      console.log(`  amount:      ${tracLine(result.amountWei)}`);
      console.log(`  session key: ${result.sessionKeyAddress}`);
      console.log(`  txHash:      ${result.txHash}`);
      console.log(`  block:       ${result.blockNumber}`);
    } catch (err) {
      fail(toErrorMessage(err));
    }
  });

marketplaceCmd
  .command('invoke')
  .description('Route one marketplace call: quote, authorize, serve off-chain, verify the receipt, settle the meter')
  .requiredOption('--service <type>', `Service type (${SERVICE_TYPES.join(', ')})`)
  .option('--model <modelId>', 'Restrict routing to offers for this model')
  .option('--prompt <text>', 'Inference payload shorthand for --payload {"prompt": <text>}')
  .option('--sparql <query>', 'Query payload shorthand for --payload {"sparql": <query>}')
  .option('--payload <json>', 'Raw executor payload as a JSON object string')
  .option('--max-units <units>', 'Worst-case unit grant of the authorization (default 1000)')
  .option('--json', 'Print the raw JSON response')
  .action(async (opts: {
    service: string; model?: string; prompt?: string; sparql?: string;
    payload?: string; maxUnits?: string; json?: boolean;
  }) => {
    try {
      if (!(SERVICE_TYPES as readonly string[]).includes(opts.service)) {
        fail(`--service must be one of ${SERVICE_TYPES.join(', ')}`);
      }
      const payloadSources = [opts.prompt, opts.sparql, opts.payload].filter((value) => value !== undefined);
      if (payloadSources.length !== 1) {
        fail('Pass exactly one of --prompt, --sparql or --payload');
      }
      let payload: Record<string, unknown>;
      if (opts.prompt !== undefined) payload = { prompt: opts.prompt };
      else if (opts.sparql !== undefined) payload = { sparql: opts.sparql };
      else {
        const parsed: unknown = JSON.parse(opts.payload as string);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail('--payload must be a JSON object string');
        }
        payload = parsed as Record<string, unknown>;
      }
      const client = await ApiClient.connect();
      const result = await client.marketplace.invoke({
        serviceType: opts.service as MarketplaceServiceTypeWire,
        ...(opts.model !== undefined ? { modelId: opts.model } : {}),
        payload,
        ...(opts.maxUnits !== undefined ? { maxUnits: opts.maxUnits } : {}),
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log('Served:');
      console.log(`  seller:   identity ${result.seller.identityId} (${result.seller.peerId})`);
      console.log(`  units:    ${result.servedUnits}`);
      console.log(`  cost:     ${tracLine(result.costWei)}`);
      console.log(`  receipt:  ${result.receipt.authDigest} (commitment ${result.receipt.resultCommitment})`);
      console.log(`  result:   ${JSON.stringify(result.result)}`);
    } catch (err) {
      fail(toErrorMessage(err));
    }
  });

marketplaceCmd
  .command('meter')
  .description('Show the buyer meter: used, remaining and reserved per plan bucket')
  .option('--json', 'Print the raw JSON response')
  .action(async (opts: { json?: boolean }) => {
    try {
      const client = await ApiClient.connect();
      const meter = await client.marketplace.meter();
      if (opts.json) {
        console.log(JSON.stringify(meter, null, 2));
        return;
      }
      if (!meter.state && meter.summary === undefined) {
        console.log('No active subscription — `dkg marketplace subscribe` first');
        return;
      }
      printMeterState(meter.state, meter.summary);
    } catch (err) {
      fail(toErrorMessage(err));
    }
  });

marketplaceCmd
  .command('settle <action>')
  .description(`Settlement/ops rail: ${SETTLE_ACTIONS.join(' | ')} (finalize/claim/roll require the settlement deadline to have passed)`)
  .option('--buyer <address>', 'Bucket buyer for finalize (default: this node\'s funding wallet)')
  .option('--epoch <epoch>', 'Target epoch (default: the active subscription\'s funded epoch)')
  .option('--json', 'Print the raw JSON response')
  .action(async (action: string, opts: { buyer?: string; epoch?: string; json?: boolean }) => {
    try {
      if (!(SETTLE_ACTIONS as readonly string[]).includes(action)) {
        fail(`action must be one of ${SETTLE_ACTIONS.join(', ')}`);
      }
      const client = await ApiClient.connect();
      const result = await client.marketplace.settle({
        action: action as MarketplaceSettleActionWire,
        ...(opts.buyer !== undefined ? { buyer: opts.buyer } : {}),
        ...(opts.epoch !== undefined ? { epoch: opts.epoch } : {}),
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.batches !== undefined) {
        console.log(`Flushed ${result.batches} batch(es), ${result.claims} claim(s) submitted, ${result.failedClaims} dropped`);
        for (const error of result.errors ?? []) console.log(`  error: ${error}`);
        return;
      }
      console.log(`Settle ${action}:`);
      console.log(`  txHash: ${result.txHash}`);
      console.log(`  block:  ${result.blockNumber}`);
      if (result.rewardWei !== undefined) console.log(`  reward: ${tracLine(result.rewardWei)}`);
    } catch (err) {
      fail(toErrorMessage(err));
    }
  });

}

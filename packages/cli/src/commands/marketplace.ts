// SPDX-License-Identifier: Apache-2.0

// ─── dkg marketplace — the marketplace buyer and seller (OT-RFC-27) ──
//
// A command for each route under /api/marketplace: subscriptions, dry runs,
// fundings and top-ups, the standing plan, the buyer wallet's funding,
// accounts, an owner's actions on an account the node owns, the gateway's
// access keys, the reconciliation, and the seller's Operate, landing and
// prices. Each prints the daemon's answer as JSON. Amounts on the command
// line are in TRAC but prices per unit, which are in wei; times are chain
// seconds. Requests with services take a JSON file.

import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { ethers } from 'ethers';
import { toErrorMessage } from '@origintrail-official/dkg-core';
import { ApiClient } from '../api-client.js';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Send one request, its body read by `body` (a file, amounts), and print the answer; any failure exits 1. */
async function call(method: Method, path: string, body?: () => unknown): Promise<void> {
  try {
    const payload = body ? await body() : undefined;
    const answer = await (await ApiClient.connect()).marketplace(method, path, payload);
    console.log(JSON.stringify(answer, null, 2));
  } catch (err) {
    const refusal = (err as { responseBody?: { code?: unknown } }).responseBody;
    console.error(typeof refusal?.code === 'string' ? `${refusal.code}: ${toErrorMessage(err)}` : toErrorMessage(err));
    process.exit(1);
  }
}

async function jsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

const id = (value: string) => encodeURIComponent(value);

function limits(opts: { maxCost: string; expiresAt: string }): { maxCostPerEpoch: string; expiresAt: number } {
  return { maxCostPerEpoch: ethers.parseEther(opts.maxCost).toString(), expiresAt: Number(opts.expiresAt) };
}

export function registerMarketplaceCommand(program: Command): void {
  const cmd = program
    .command('marketplace')
    .description('Marketplace: the buyer\'s subscriptions, plan, funding and accounts, and the seller\'s Operate (OT-RFC-27)');

  cmd
    .command('subscriptions')
    .description("The buyer's subscriptions and their budgets: this epoch's and the next one's by default")
    .option('--epoch <epoch>', 'current, next or an epoch number')
    .action((opts: { epoch?: string }) => call('GET', `/subscriptions${opts.epoch ? `?epoch=${id(opts.epoch)}` : ''}`));

  cmd
    .command('dry-run <file>')
    .description('The cost of a funding and the refusal it would meet; the file is { epoch, source, services }')
    .action((file: string) => call('POST', '/subscriptions/preview', () => jsonFile(file)));

  cmd
    .command('fund <file>')
    .description('Fund the current or the next epoch; the file is { epoch, source, services }')
    .action((file: string) => call('POST', '/subscriptions', () => jsonFile(file)));

  cmd
    .command('top-up <subscriptionId> <file>')
    .description('Add value or services to a subscription; the file is { services }')
    .option('--dry-run', 'only the cost and the refusal it would meet; nothing is sent')
    .action((subscriptionId: string, file: string, opts: { dryRun?: boolean }) =>
      call('POST', `/subscriptions/${id(subscriptionId)}/top-up${opts.dryRun ? '/preview' : ''}`, () => jsonFile(file)));

  const plan = cmd.command('plan').description('The standing plan and its next renewal');
  plan.command('show', { isDefault: true }).description('Show the standing plan').action(() => call('GET', '/plan'));
  plan
    .command('set <file>')
    .description('Confirm a standing plan; the file is { services, source, renew, renewUntilEpoch }')
    .action((file: string) => call('PUT', '/plan', () => jsonFile(file)));

  cmd.command('funding').description('The buyer wallet, its balances and allowance, and the accounts it can use').action(() => call('GET', '/funding'));
  cmd.command('accounts').description('The accounts the node owns or that granted the buyer wallet').action(() => call('GET', '/accounts'));
  cmd.command('contracts').description('What a browser wallet needs to act as an account owner').action(() => call('GET', '/accounts/contracts'));

  cmd
    .command('consent <accountId>')
    .description("The buyer wallet's signed consent to a grant, for the account owner's wallet to send")
    .requiredOption('--max-cost <trac>', 'the most one subscription may cost, in TRAC')
    .requiredOption('--expires-at <seconds>', 'when the grant ends, in chain seconds')
    .action((accountId: string, opts: { maxCost: string; expiresAt: string }) => call('POST', `/accounts/${id(accountId)}/buyer-consent`, () => limits(opts)));

  cmd
    .command('spending <accountId> <state>')
    .description('Opt an account the node owns in to service spending (on) or out (off)')
    .action((accountId: string, state: string) => {
      if (state !== 'on' && state !== 'off') {
        console.error('state must be on or off');
        process.exit(1);
      }
      return call('POST', `/accounts/${id(accountId)}/service-spending`, () => ({ enabled: state === 'on' }));
    });

  cmd
    .command('add-buyer <accountId>')
    .description('Add a buyer to an account the node owns: the buyer wallet unless --buyer is given')
    .requiredOption('--max-cost <trac>', 'the most one subscription may cost, in TRAC')
    .requiredOption('--expires-at <seconds>', 'when the grant ends, in chain seconds')
    .option('--buyer <address>', 'another buyer')
    .option('--signature <hex>', "that buyer's consent")
    .action((accountId: string, opts: { maxCost: string; expiresAt: string; buyer?: string; signature?: string }) =>
      call('POST', `/accounts/${id(accountId)}/buyers`, () => ({
        ...limits(opts),
        ...(opts.buyer ? { buyer: opts.buyer } : {}),
        ...(opts.signature ? { buyerSignature: opts.signature } : {}),
      })));

  cmd
    .command('limits <accountId> <buyer>')
    .description("Change a buyer's limit and expiry on an account the node owns")
    .requiredOption('--max-cost <trac>', 'the most one subscription may cost, in TRAC')
    .requiredOption('--expires-at <seconds>', 'when the grant ends, in chain seconds')
    .action((accountId: string, buyer: string, opts: { maxCost: string; expiresAt: string }) =>
      call('POST', `/accounts/${id(accountId)}/buyers/${id(buyer)}/limits`, () => limits(opts)));

  const keys = cmd.command('keys').description("Access keys for the gateway, which the node's agents call it with");
  keys.command('list', { isDefault: true }).description('The access keys, without their secrets').action(() => call('GET', '/keys'));
  keys
    .command('make')
    .description('Make an access key; its secret is shown this once')
    .requiredOption('--label <label>', 'what the key is for')
    .requiredOption('--budget <trac>', 'the most its calls may cost together, in TRAC')
    .option('--service <serviceId...>', 'the services it may call; all by default')
    .option('--rps <n>', 'calls per second', '5')
    .option('--expires-at <seconds>', 'when it stops working')
    .action((opts: { label: string; budget: string; service?: string[]; rps: string; expiresAt?: string }) => call('POST', '/keys', () => ({
      label: opts.label,
      budget: ethers.parseEther(opts.budget).toString(),
      rps: Number(opts.rps),
      ...(opts.service ? { services: opts.service } : {}),
      ...(opts.expiresAt ? { expiresAt: Number(opts.expiresAt) } : {}),
    })));
  keys
    .command('revoke <keyId>')
    .description('Revoke an access key; it stops working at its next call')
    .action((keyId: string) => call('POST', `/keys/${id(keyId)}/revoke`));

  cmd
    .command('reconciliation')
    .description("The receipts the node holds against those landed and counted, per seller and budget: this epoch's by default")
    .option('--epoch <epoch>', 'current or an epoch number')
    .action((opts: { epoch?: string }) => call('GET', `/reconciliation${opts.epoch ? `?epoch=${id(opts.epoch)}` : ''}`));

  cmd.command('catalog').description("This epoch's services, with their sellers' offers and prices").action(() => call('GET', '/catalog'));
  cmd
    .command('service <serviceId>')
    .description('One service, with a row per seller')
    .action((serviceId: string) => call('GET', `/services/${id(serviceId)}`));
  cmd
    .command('storefront <identityId>')
    .description('One seller: its Core Node gate, offers and served value in recent epochs')
    .action((identityId: string) => call('GET', `/sellers/${id(identityId)}`));
  cmd
    .command('activity')
    .description("The calls through the gateway, this epoch's by default, and whether each is held, landed or missed")
    .option('--epoch <epoch>', 'current, next or an epoch number')
    .option('--key <keyId>', "one access key's calls")
    .action((opts: { epoch?: string; key?: string }) => {
      const query = new URLSearchParams({ ...(opts.epoch ? { epoch: opts.epoch } : {}), ...(opts.key ? { key: opts.key } : {}) }).toString();
      return call('GET', `/activity${query ? `?${query}` : ''}`);
    });

  const sell = cmd.command('seller').description("The node's selling: its Core Node gate, offerings, ledger and landing");
  sell
    .command('status', { isDefault: true })
    .description('The gate, the offerings and their prices, the ledger, the next landing and recent batches')
    .action(() => call('GET', '/seller'));
  sell.command('land').description('Land the receipts that are ready, due or not').action(() => call('POST', '/seller/land'));
  sell
    .command('price <serviceId> <wei>')
    .description("Set a service's price for the next epoch, in wei per unit; this epoch's stays as it is")
    .action((serviceId: string, wei: string) => call('PUT', `/seller/offerings/${id(serviceId)}/price`, () => ({ price: wei })));

  cmd
    .command('remove-buyer <accountId> <buyer>')
    .description('Remove a buyer from an account the node owns; its funded subscriptions run to their end')
    .action((accountId: string, buyer: string) => call('DELETE', `/accounts/${id(accountId)}/buyers/${id(buyer)}`));
}

// SPDX-License-Identifier: Apache-2.0
/**
 * The marketplace in a real daemon on the shared Hardhat node: with
 * `marketplace.enabled` in its config, the daemon builds the buyer at boot, and
 * the job's first tick funds the current epoch from the standing plan, from the
 * node's own operational wallet. Its routes answer over HTTP.
 */
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { subscriptionIdOf } from '@origintrail-official/dkg-chain';
import { BuyerStore, parsePlan } from '@origintrail-official/dkg-marketplace';
import { createEVMAdapter, createProvider, getSharedContext, revertSnapshot, takeSnapshot } from '../../chain/test/evm-test-context.js';
import { HARDHAT_KEYS, mintTokens } from '../../chain/test/hardhat-harness.js';
import { authHeaders, sleep, startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';

const TRAC = 10n ** 18n;

let daemon: LiveDaemon | undefined;
let snapshot: string | undefined;
afterAll(async () => {
  await stopLiveDaemon(daemon);
  if (snapshot) await revertSnapshot(snapshot);
});

describe('the marketplace in a live daemon', () => {
  it('funds the current epoch from the standing plan at boot, and answers its routes', async () => {
    snapshot = await takeSnapshot();
    // The live daemon's operational wallet, and so its buyer wallet.
    const buyerWallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address;
    await mintTokens(createProvider(), getSharedContext().hubAddress, HARDHAT_KEYS.DEPLOYER, buyerWallet, 1_000n * TRAC);
    const { epoch } = await createEVMAdapter(HARDHAT_KEYS.EXTRA3).getEpochTimes();
    const plan = parsePlan({
      services: [{ serviceId: ethers.id('urn:dkg:model:a'), serviceClass: 'inference', value: String(10n * TRAC), maxPricePerUnit: '1000000000000' }],
      source: { kind: 'wallet' },
      renew: true,
      renewUntilEpoch: epoch,
    });

    daemon = await startLiveDaemon({
      extraConfig: { marketplace: { enabled: true } },
      prepareHome: async (home) => { await new BuyerStore(join(home, 'marketplace')).writePlan(plan); },
    });
    const get = async (path: string) => {
      const res = await fetch(`${daemon!.base}/api/marketplace${path}`, { headers: authHeaders(daemon!) });
      return { status: res.status, body: await res.json() as any };
    };

    let subscriptions: any[] = [];
    for (let i = 0; i < 120 && subscriptions.length === 0; i++) {
      const answer = await get('/subscriptions?epoch=current');
      expect(answer.status).toBe(200);
      subscriptions = answer.body.subscriptions;
      if (subscriptions.length === 0) await sleep(250);
    }
    expect(subscriptions).toMatchObject([{
      subscriptionId: subscriptionIdOf(buyerWallet, epoch), epoch, source: { kind: 'wallet' }, value: String(10n * TRAC),
    }]);
    const funding = await get('/funding');
    expect(funding.body.buyerWallet.address).toBe(buyerWallet);
    // The plan's last epoch is funded: no renewal is due.
    const shown = await get('/plan');
    expect(shown).toMatchObject({ status: 200, body: { renew: true, renewUntilEpoch: epoch } });
    expect(shown.body).not.toHaveProperty('next');
  });
});

// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  DEFAULT_PREFUND_LEAD_MINUTES,
  PlanError,
  budgetsOf,
  parseEpoch,
  parsePlan,
  parseWei,
  planDigestOf,
  planToWire,
  resolveMarketplaceConfig,
  type StandingPlanWire,
} from '../src/index.js';

const A = `0x${'0a'.repeat(32)}`;
const B = `0x${'0b'.repeat(32)}`;
const WALLET = ethers.getAddress('0x00000000000000000000000000000000000000a1');
const OTHER = ethers.getAddress('0x00000000000000000000000000000000000000a2');

const wire: StandingPlanWire = {
  services: [
    { serviceId: B, serviceClass: 'query', value: '200', maxPricePerUnit: '2' },
    { serviceId: A.toUpperCase().replace('0X', '0x'), serviceClass: 'inference', value: '100', maxPricePerUnit: '1', pinnedSeller: 7 },
  ],
  source: { kind: 'account', accountId: '5' },
  renew: true,
  renewUntilEpoch: 670,
};

describe('the marketplace config', () => {
  it('defaults to off, the primary wallet, a 120-minute prefund lead and a 300-second tick', () => {
    expect(resolveMarketplaceConfig(undefined, [WALLET, OTHER])).toEqual({
      enabled: false, buyerWallet: WALLET, prefundLeadSeconds: DEFAULT_PREFUND_LEAD_MINUTES * 60, tickSeconds: 300,
    });
    expect(resolveMarketplaceConfig({ enabled: true, buyerWallet: OTHER.toLowerCase(), prefundLeadMinutes: 1.5 }, [WALLET, OTHER]))
      .toMatchObject({ enabled: true, buyerWallet: OTHER, prefundLeadSeconds: 90 });
  });

  it('refuses a buyer wallet the node cannot sign for, and bad durations', () => {
    expect(() => resolveMarketplaceConfig({ buyerWallet: OTHER }, [WALLET])).toThrow(/not one of this node's operational wallets/);
    expect(() => resolveMarketplaceConfig(undefined, [])).toThrow(/no operational wallet/);
    expect(() => resolveMarketplaceConfig({ prefundLeadMinutes: 0 }, [WALLET])).toThrow(/prefundLeadMinutes/);
    expect(() => resolveMarketplaceConfig({ tickSeconds: 0.5 }, [WALLET])).toThrow(/tickSeconds/);
  });
});

describe('the standing plan', () => {
  it('parses the wire form: services sorted by id, amounts in wei, the class as a number', () => {
    const plan = parsePlan(wire);
    expect(plan.services.map((s) => s.serviceId)).toEqual([A, B]);
    expect(plan.services[0]).toEqual({ serviceId: A, serviceClass: 1, value: 100n, maxPricePerUnit: 1n, pinnedSeller: 7n });
    expect(plan.source).toEqual({ kind: 'account', accountId: 5n });
    expect(planToWire(plan)).toEqual({ ...wire, services: [{ ...wire.services[1]!, serviceId: A }, wire.services[0]] });
    expect(budgetsOf(plan.services).map((b) => b.serviceId)).toEqual([A, B]);
  });

  it.each([
    [{ ...wire, renew: 'yes' }, /renew must be/],
    [{ ...wire, renewUntilEpoch: undefined }, /needs renewUntilEpoch/],
    [{ ...wire, renewUntilEpoch: 0 }, /positive epoch/],
    [{ ...wire, services: [] }, /non-empty/],
    [{ ...wire, services: [{ ...wire.services[0]!, serviceId: '0x01' }] }, /32-byte/],
    [{ ...wire, services: [{ ...wire.services[0]!, serviceClass: 'model' }] }, /inference or query/],
    [{ ...wire, services: [{ ...wire.services[0]!, value: '0' }] }, /above 0/],
    [{ ...wire, services: [{ ...wire.services[0]!, value: '1.5' }] }, /decimal string of wei/],
    [{ ...wire, services: [wire.services[0], wire.services[0]] }, /listed twice/],
    [{ ...wire, source: { kind: 'account', accountId: '0' } }, /source must be/],
  ])('refuses %j', (raw, message) => {
    expect(() => parsePlan(raw)).toThrow(PlanError);
    expect(() => parsePlan(raw)).toThrow(message);
  });

  it('reads an epoch as current, next or a number', () => {
    expect([parseEpoch('current', 663), parseEpoch('next', 663), parseEpoch(670, 663), parseEpoch('670', 663)]).toEqual([663, 664, 670, 670]);
    for (const bad of [0, -1, 1.5, '0', 'later', undefined]) expect(() => parseEpoch(bad, 663)).toThrow(PlanError);
    expect(parseWei('5', 'value')).toBe(5n);
    expect(() => parseWei(5, 'value')).toThrow(/decimal string of wei/);
    expect(() => parseWei(String(1n << 96n), 'value')).toThrow(/fit 96 bits/);
  });

  it('a plan that does not renew needs no last epoch', () => {
    expect(parsePlan({ ...wire, renew: false, renewUntilEpoch: undefined }).renew).toBe(false);
  });

  it('the plan digest commits to the epoch, the buyer and every budget term', () => {
    const budgets = budgetsOf(parsePlan(wire).services);
    const digest = planDigestOf(663, WALLET, budgets);
    expect(digest).toBe(ethers.id(JSON.stringify({ epoch: 663, buyer: WALLET, budgets: [[A, '1', '100', '1'], [B, '2', '200', '2']] })));
    expect(planDigestOf(664, WALLET, budgets)).not.toBe(digest);
    expect(planDigestOf(663, OTHER, budgets)).not.toBe(digest);
    expect(planDigestOf(663, WALLET, [{ ...budgets[0]!, value: 101n }, budgets[1]!])).not.toBe(digest);
  });
});

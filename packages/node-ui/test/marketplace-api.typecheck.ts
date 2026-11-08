// The node's marketplace answers, as its route tests and views write them,
// against the UI's types: a field the node sends that the UI lacks, or one the
// UI needs that the node does not send, fails the type check.
import type {
  CatalogAnswer, ChatCompletion, GatewayRefusalBody, KeysAnswer, LandNowAnswer, MadeKey, Plan, Preview, RefusalBody,
  SellerStatus, ServiceDetail, Storefront, SubscriptionsAnswer, Funding, ReconciliationAnswer, ActivityAnswer,
} from '../src/ui/marketplace/api/types.js';
import { fixtureWorld } from '../src/ui/marketplace/api/fixtures.js';

const A = '0x1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c';

// A node with no reference rate and one seller that has not quoted yet.
({
  epoch: 663,
  fx: { tracUsd: null, source: 'none', asOf: null },
  services: [{
    serviceId: A, serviceClass: 'inference', label: 'urn:test:model:a',
    offers: [{
      serviceId: A, seller: 4, epoch: 663, unit: 'token', pricePerUnit: '10', pricePerUnitTrac: '0.00000000000000001',
      provenance: 'upstream-claimed', available: null, measured: { latencyMs: null, tokensPerSecond: null },
    }],
    priceMin: '10', priceMinTrac: '0.00000000000000001', priceMax: '10', priceMaxTrac: '0.00000000000000001',
  }],
}) satisfies CatalogAnswer;

// The keys list never carries a secret; the key just made carries it once.
({ keys: [{ keyId: 'dkgmk_0011aabb', label: 'agent', budget: '1000000000000000000', spent: '0', services: null, rps: 100, expiresAt: null, revoked: false, lastUsedAt: null }] }) satisfies KeysAnswer;
({ keyId: 'dkgmk_0011aabb', label: 'agent', budget: '1', spent: '0', services: [A], rps: 5, expiresAt: 1_800_000_000, revoked: false, lastUsedAt: null, secret: 'dkgmk_0011aabb' }) satisfies MadeKey;

// A dry run the contracts would refuse, and a plan with its next renewal.
({ epoch: 664, source: { kind: 'account', accountId: '7', discountBps: 1000 }, value: '5', valueTrac: '0.000000000000000005', cost: '4', costTrac: '0.000000000000000004', discountBps: 1000, refusal: { code: 'LimitExceeded', args: ['maxCostPerEpoch', '1', '4'] } }) satisfies Preview;
({ services: [{ serviceId: A, serviceClass: 'inference', value: '5', valueTrac: '0.000000000000000005', maxPricePerUnit: '10', maxPricePerUnitTrac: '0.00000000000000001' }], source: { kind: 'wallet' }, renew: true, renewUntilEpoch: 670, next: { epoch: 665, at: 1_800_000_000, cost: '5', costTrac: '0.000000000000000005', refusal: 'ERC20InsufficientBalance' } }) satisfies Plan;

// Landing that stopped, and the refusals in both shapes.
({ batches: [], stopped: 'end-margin' }) satisfies LandNowAnswer;
({ error: 'NodeAdminRequired', code: 'NodeAdminRequired', retryable: false }) satisfies RefusalBody;
({ error: 'Not found' }) satisfies RefusalBody;
({ error: { code: 'soft_ceiling', message: 'the budget is at its soft ceiling', type: 'marketplace' }, serviceId: A, left: '0', leftTrac: '0.0', fork: { topUp: true, nextEpochAt: 1_800_000_000 } }) satisfies GatewayRefusalBody;
({ error: { code: 'epoch_ending', message: 'the epoch is ending', type: 'marketplace' }, nextEpochAt: 1_800_000_000 }) satisfies GatewayRefusalBody;

// The fixture node's answers, which the section's tests and screenshots use.
const world = fixtureWorld(0);
world.catalog(true) satisfies CatalogAnswer;
world.detail(world.current.budgets[0].serviceId, true) satisfies ServiceDetail;
world.storefront(12) satisfies Storefront;
({ subscriptions: [world.current, world.next] }) satisfies SubscriptionsAnswer;
world.plan(true) satisfies Plan;
world.funding satisfies Funding;
world.activity satisfies ActivityAnswer;
world.reconciliation(663, true) satisfies ReconciliationAnswer;
({ keys: world.keys }) satisfies KeysAnswer;
world.sellerStatus satisfies SellerStatus;
world.landNow satisfies LandNowAnswer;
world.chat('urn:dkg:model:qwen2.5-14b-instruct', world.current.budgets[0].serviceId) satisfies ChatCompletion;

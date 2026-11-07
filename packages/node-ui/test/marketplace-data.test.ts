import { describe, expect, it } from 'vitest';
import { fixtureData, isMarketplaceError, MarketplaceError } from '../src/ui/marketplace/data.js';
import {
  FIXTURE_ADDRESSES, FIXTURE_SCENARIOS, fixtureCatalog, fixtureIntent, fixtureOperateStatus, fixturePlanStatus,
} from '../src/ui/marketplace/fixtures.js';
import { COPY, copy } from '../src/ui/marketplace/copy.generated.js';

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

describe('marketplace fixture data', () => {
  it('serves every screen from fixtures, with no network', async () => {
    const data = fixtureData(() => 'plan-active', () => NOW);
    const [catalog, status, operate, ops, draft] = await Promise.all([
      data.catalog(), data.planStatus(), data.operateStatus(), data.operationsWallet(), data.nextPeriodDraft(),
    ]);
    expect(catalog.shelves.map((s) => s.seller)).toEqual([FIXTURE_ADDRESSES.sellerA, FIXTURE_ADDRESSES.sellerB]);
    expect(catalog.fx).toEqual({ tracUsd: 0.28, source: 'reference', asOf: null });
    expect(status.plan?.periodMs).toBe(30 * 86_400_000);
    expect(operate.sellerActive).toBe(true);
    expect(ops).toBe(FIXTURE_ADDRESSES.ops);
    expect(draft).toBeNull();
  });

  it('keeps the plan twelve days from reset with the meters the plan pays for', () => {
    const status = fixturePlanStatus('plan-active', NOW);
    const left = new Date(status.plan!.expiresAt).getTime() - NOW;
    expect(Math.floor(left / 86_400_000)).toBe(12);
    const pct = Object.fromEntries(status.meters.map((m) => [m.offeringId, Math.round((m.consumedUnits / m.guaranteedUnits) * 100)]));
    expect(pct).toEqual({ 'qwen25-14b': 24, 'qwen25-7b': 12, 'gpt-5x': 100, 'okf-knowledge': 87 });
    expect(status.statements[0].items.reduce((s, i) => s + i.buyerCount, 0)).toBe(1_238_400);
  });

  it('shows a purchase at each step it can resume from', () => {
    expect(fixturePlanStatus('purchase-confirm', NOW).openPurchase?.state).toBe('terms_frozen');
    expect(fixturePlanStatus('purchase-pay', NOW).openPurchase?.state).toBe('paying');
    expect(fixturePlanStatus('purchase-key', NOW).openPurchase?.state).toBe('active');
    const intent = fixtureIntent('terms_frozen', NOW);
    const amounts = Object.values(intent.frozen!.sellers).map((s) => s.amountMicroTrac);
    expect(amounts).toEqual([2_800_000, 800_000]);
    expect(fixtureIntent('draft', NOW).frozen).toBeNull();
  });

  it('uses synthetic placeholder addresses only', () => {
    const blob = JSON.stringify([
      ...FIXTURE_SCENARIOS.map((s) => fixturePlanStatus(s, NOW)), fixtureCatalog(NOW), fixtureOperateStatus(NOW),
    ]);
    const addresses = new Set(blob.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []);
    for (const a of addresses) expect(a).toMatch(/^0x([0-9a-f]{2})\1{19}$/);
  });

  it('describes refusals in the node error shape', () => {
    const e = new MarketplaceError(409, { error: 'E_INTENT_OPEN', code: 'E_INTENT_OPEN', retryable: false });
    expect(isMarketplaceError(e)).toBe(true);
    expect(e.code).toBe('E_INTENT_OPEN');
    expect(new MarketplaceError(503, {}).retryable).toBe(true);
  });

  it('fills copy placeholders and flags a missing key', () => {
    expect(copy('chip.left', { pct: 76 })).toBe('76% left');
    expect(copy('no.such.key')).toContain('missing copy');
    expect(Object.keys(COPY).length).toBeGreaterThan(500);
  });
});

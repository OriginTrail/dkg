// @vitest-environment happy-dom
//
// A4 — shared PCA sub-components: render + accessibility contracts. Also covers
// the A3 EmptyState `warning` tone (pure TS accent add). Mirrors the render
// helper used by `context-graph-empty-stat-components.test.ts`.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HealthChip,
  HEALTH_CHIP_META,
  WalletRow,
  AddressCrux,
  DiscountTierLadder,
  discountTierForTrac,
  DiscountAppliedBadge,
  convictionDiscountBps,
  EligibilityVerdictBanner,
  SponsorshipHandshake,
} from '../src/ui/components/Pca/index.js';
import {
  healthForSnapshot,
  isPcaExpired,
  PCA_CAP_NEAR_THRESHOLD,
  PCA_EXPIRING_SOON_SECONDS,
  type PcaHealthState,
} from '../src/ui/pca/health.js';
import { EmptyState } from '../src/ui/components/ContextGraphPrimitives.js';

async function render(node: React.ReactElement): Promise<{
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    root,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  valueSetter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('HealthChip', () => {
  const states: PcaHealthState[] = ['healthy', 'expiring', 'expired', 'insolvent', 'swept', 'cap-near'];

  it('renders a text label (never glyph-only) and an aria-hidden glyph for every state', async () => {
    for (const state of states) {
      const { container, unmount } = await render(React.createElement(HealthChip, { state }));
      const chip = container.querySelector('.v10-pca-health-chip')!;
      expect(chip).toBeTruthy();
      expect(chip.getAttribute('data-testid')).toBe('pca-health-chip'); // e2e anchor
      expect(chip.getAttribute('data-health')).toBe(state);
      // Label text present (the accessible name).
      expect(container.querySelector('.v10-pca-health-label')?.textContent).toBe(
        HEALTH_CHIP_META[state].label,
      );
      // Glyph is decorative.
      expect(container.querySelector('.v10-pca-health-glyph')?.getAttribute('aria-hidden')).toBe('true');
      // Tone class applied.
      expect(chip.classList.contains(HEALTH_CHIP_META[state].toneClass)).toBe(true);
      await unmount();
    }
  });

  it('allows overriding the label text (e.g. with a wall-clock suffix)', async () => {
    const { container, unmount } = await render(
      React.createElement(HealthChip, { state: 'expiring', label: 'Expires in ~12 days' }),
    );
    expect(container.querySelector('.v10-pca-health-label')?.textContent).toBe('Expires in ~12 days');
    await unmount();
  });

  it('renders insolvent in the DANGER tone (badge-error), distinct from warn states (§6.4/G5)', () => {
    expect(HEALTH_CHIP_META.insolvent.toneClass).toBe('badge-error');
    // Expiring / cap-near stay warn-toned — insolvent must NOT collapse into them.
    expect(HEALTH_CHIP_META.expiring.toneClass).toBe('badge-warn');
    expect(HEALTH_CHIP_META['cap-near'].toneClass).toBe('badge-warn');
    expect(HEALTH_CHIP_META.expired.toneClass).toBe('badge-error');
  });
});

describe('healthForSnapshot (single source of truth for S1/S3/S5)', () => {
  const NOW = 1_000_000; // arbitrary nowSec
  const base = { expiresAtTimestamp: NOW + 30 * 24 * 3600, fullySwept: false, agentCount: 1 };

  it('returns healthy for a solvent, far-from-expiry, low-cap account', () => {
    expect(healthForSnapshot(base, NOW)).toBe('healthy');
  });

  it('expired takes precedence over everything once nowSec >= expiry', () => {
    expect(
      healthForSnapshot({ ...base, expiresAtTimestamp: NOW - 1, fullySwept: true, agentCount: 100 }, NOW),
    ).toBe('expired');
    // Exactly at expiry counts as expired.
    expect(healthForSnapshot({ ...base, expiresAtTimestamp: NOW }, NOW)).toBe('expired');
  });

  it('swept outranks cap-near and expiring (when not expired)', () => {
    expect(healthForSnapshot({ ...base, fullySwept: true, agentCount: 100 }, NOW)).toBe('swept');
  });

  it('cap-near fires at the threshold and outranks expiring', () => {
    expect(healthForSnapshot({ ...base, agentCount: PCA_CAP_NEAR_THRESHOLD }, NOW)).toBe('cap-near');
    expect(healthForSnapshot({ ...base, agentCount: PCA_CAP_NEAR_THRESHOLD - 1 }, NOW)).not.toBe('cap-near');
  });

  it('expiring fires within the 7-day window', () => {
    expect(
      healthForSnapshot({ ...base, expiresAtTimestamp: NOW + PCA_EXPIRING_SOON_SECONDS }, NOW),
    ).toBe('expiring');
    expect(
      healthForSnapshot({ ...base, expiresAtTimestamp: NOW + PCA_EXPIRING_SOON_SECONDS + 1 }, NOW),
    ).toBe('healthy');
  });

  it('never derives insolvent in P0 (deferred to P2 — invariant #9)', () => {
    // No combination of P0 snapshot fields should yield 'insolvent'.
    const states = new Set([
      healthForSnapshot(base, NOW),
      healthForSnapshot({ ...base, fullySwept: true }, NOW),
      healthForSnapshot({ ...base, agentCount: 100 }, NOW),
      healthForSnapshot({ ...base, expiresAtTimestamp: NOW - 5 }, NOW),
      healthForSnapshot({ ...base, expiresAtTimestamp: NOW + 100 }, NOW),
    ]);
    expect(states.has('insolvent' as PcaHealthState)).toBe(false);
  });

  it('treats a missing/zero expiry as "no expiry data" (never expired/expiring)', () => {
    expect(healthForSnapshot({ ...base, expiresAtTimestamp: 0 }, NOW)).toBe('healthy');
  });
});

describe('isPcaExpired (shared liveness primitive — single expiry source, #1344 C-live)', () => {
  const NOW = 1_000_000;
  it('expired exactly at and past the boundary; not before', () => {
    expect(isPcaExpired({ expiresAtTimestamp: NOW }, NOW)).toBe(true); // boundary counts as expired
    expect(isPcaExpired({ expiresAtTimestamp: NOW - 1 }, NOW)).toBe(true);
    expect(isPcaExpired({ expiresAtTimestamp: NOW + 1 }, NOW)).toBe(false);
  });
  it('treats 0 / absent expiry as "no lock period" → never expired', () => {
    expect(isPcaExpired({ expiresAtTimestamp: 0 }, NOW)).toBe(false);
    expect(isPcaExpired({ expiresAtTimestamp: undefined as unknown as number }, NOW)).toBe(false);
  });
  it('is exactly healthForSnapshot’s expired discriminant', () => {
    // The two stay lockstep: expired-state ⟺ isPcaExpired (the C-live contract).
    expect(healthForSnapshot({ expiresAtTimestamp: NOW, fullySwept: false, agentCount: 1 }, NOW)).toBe('expired');
    expect(isPcaExpired({ expiresAtTimestamp: NOW }, NOW)).toBe(true);
  });
});

describe('WalletRow', () => {
  it('exposes the full address + status in the accessible name; status is textual', async () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    const { container, unmount } = await render(
      React.createElement(WalletRow, { address: addr, status: 'approved', statusTone: 'success' }),
    );
    const row = container.querySelector('.v10-pca-wallet-row')!;
    expect(row.getAttribute('role')).toBe('group');
    // Full address (not the truncated form) lives in aria-label, with status.
    expect(row.getAttribute('aria-label')).toBe(`${addr}, approved`);
    // Visible address is truncated but the full address is in the title.
    const addrEl = container.querySelector('.v10-pca-wallet-addr')!;
    expect(addrEl.textContent).toContain('…');
    expect(addrEl.getAttribute('title')).toBe(addr);
    // Status is rendered as text with a tone data attribute (not colour-only).
    const status = container.querySelector('.v10-pca-wallet-status')!;
    expect(status.textContent).toBe('approved');
    expect(status.getAttribute('data-tone')).toBe('success');
    // Copy control carries the full address in its accessible name.
    const copy = container.querySelector('.v10-pca-copy-btn')!;
    expect(copy.getAttribute('aria-label')).toContain(addr);
    await unmount();
  });
});

describe('AddressCrux', () => {
  it('renders the identity crux + the ERC-20 approve() disambiguation, and wires onChange', async () => {
    const onChange = vi.fn();
    const { container, unmount } = await render(
      React.createElement(AddressCrux, { value: '', onChange, mode: 'single' }),
    );
    // The identity-disambiguation copy is present.
    expect(container.textContent).toContain('NOT');
    expect(container.textContent).toContain('peerId');
    // The ERC-20 approve() disambiguation is present.
    expect(container.querySelector('.v10-pca-crux-help')?.textContent).toContain('approve()');
    const input = container.querySelector('input')!;
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    setInputValue(input, '0xabc');
    expect(onChange).toHaveBeenCalledWith('0xabc');
    await unmount();
  });

  it('renders a textarea in bulk mode and an alert region for errors', async () => {
    const { container, unmount } = await render(
      React.createElement(AddressCrux, { value: '', onChange: vi.fn(), mode: 'bulk', error: 'Bad address' }),
    );
    expect(container.querySelector('textarea')).toBeTruthy();
    const err = container.querySelector('.v10-pca-crux-error')!;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toBe('Bad address');
    await unmount();
  });
});

describe('DiscountTierLadder', () => {
  it('discountTierForTrac picks the highest tier whose floor is met', () => {
    expect(discountTierForTrac(0).bps).toBe(0);
    expect(discountTierForTrac(24_999).bps).toBe(0);
    expect(discountTierForTrac(25_000).bps).toBe(1000);
    expect(discountTierForTrac(60_000).bps).toBe(2000);
    expect(discountTierForTrac(100_000).bps).toBe(3000);
    expect(discountTierForTrac(999_999).bps).toBe(5000);
    expect(discountTierForTrac(1_000_000).bps).toBe(7500);
    expect(discountTierForTrac(5_000_000).bps).toBe(7500);
    // null / non-finite → 0% tier, never a crash.
    expect(discountTierForTrac(null).bps).toBe(0);
    expect(discountTierForTrac(undefined).bps).toBe(0);
  });

  it('highlights the active tier with aria-current and a caption', async () => {
    const { container, unmount } = await render(
      React.createElement(DiscountTierLadder, { committedTrac: 50_000 }),
    );
    const active = container.querySelector('.v10-pca-tier-row.active')!;
    expect(active).toBeTruthy();
    expect(active.getAttribute('aria-current')).toBe('true');
    expect(active.getAttribute('data-bps')).toBe('2000');
    expect(container.querySelector('.v10-pca-tier-caption')?.textContent?.toLowerCase()).toContain(
      'estimated',
    );
    await unmount();
  });

  it('highlights nothing when committedTrac is omitted', async () => {
    const { container, unmount } = await render(React.createElement(DiscountTierLadder, {}));
    expect(container.querySelector('.v10-pca-tier-row.active')).toBeNull();
    await unmount();
  });
});

describe('DiscountAppliedBadge (B8, degrade-to-hidden)', () => {
  it('renders NOTHING when the conviction-cost field is absent (no false confirmation)', async () => {
    const { container, unmount } = await render(React.createElement(DiscountAppliedBadge, {}));
    expect(container.firstChild).toBeNull();
    await unmount();
  });

  it('convictionDiscountBps computes bps from base/discounted via BigInt', () => {
    expect(
      convictionDiscountBps({
        accountId: '7',
        epoch: 1,
        baseCost: '1000',
        discountedCost: '700',
        drawnFromEpoch: '700',
        drawnFromTopUp: '0',
      }),
    ).toBe(3000);
    // Zero / invalid base → null (hide, never assert 0%).
    expect(
      convictionDiscountBps({
        accountId: '7',
        epoch: 1,
        baseCost: '0',
        discountedCost: '0',
        drawnFromEpoch: '0',
        drawnFromTopUp: '0',
      }),
    ).toBeNull();
    expect(convictionDiscountBps(null)).toBeNull();
    // #9 — a genuine 0% draw (discountedCost === baseCost, reachable on-chain) → null,
    // NOT 0, so the badge hides + the bell row drops the −% rather than claiming "−0%".
    expect(
      convictionDiscountBps({
        accountId: '7',
        epoch: 1,
        baseCost: '1000',
        discountedCost: '1000',
        drawnFromEpoch: '0',
        drawnFromTopUp: '0',
      }),
    ).toBeNull();
  });

  it('renders the confirmed discount + PCA #N when the field is present', async () => {
    const { container, unmount } = await render(
      React.createElement(DiscountAppliedBadge, {
        convictionCostCovered: {
          accountId: '7',
          epoch: 1,
          baseCost: '1000',
          discountedCost: '700',
          drawnFromEpoch: '700',
          drawnFromTopUp: '0',
        },
      }),
    );
    const badge = container.querySelector('.v10-pca-discount-applied')!;
    expect(badge).toBeTruthy();
    expect(badge.getAttribute('data-testid')).toBe('pca-discount-badge'); // e2e anchor
    expect(badge.textContent).toContain('30%');
    expect(badge.textContent).toContain('PCA #7');
    await unmount();
  });

  it('renders NOTHING for a genuine 0% draw (baseCost === discountedCost) — no false −0% (#9)', async () => {
    const { container, unmount } = await render(
      React.createElement(DiscountAppliedBadge, {
        convictionCostCovered: {
          accountId: '7', epoch: 1,
          baseCost: '1000', discountedCost: '1000', // 0% effective discount
          drawnFromEpoch: '0', drawnFromTopUp: '0',
        },
      }),
    );
    expect(container.firstChild).toBeNull();
    await unmount();
  });
});

describe('EligibilityVerdictBanner', () => {
  it('green banner names the account + discount and is role=status (polite)', async () => {
    const { container, unmount } = await render(
      React.createElement(EligibilityVerdictBanner, { verdict: 'eligible', accountId: '7', discountBps: 3000 }),
    );
    const banner = container.querySelector('.v10-pca-verdict-banner')!;
    expect(banner.getAttribute('data-testid')).toBe('pca-eligibility-verdict'); // e2e anchor
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.classList.contains('v10-pca-verdict-green')).toBe(true);
    expect(banner.textContent).toContain('PCA #7');
    expect(banner.textContent).toContain('30%');
    // No escrow caveat for the default (non-owner) publish.
    expect(banner.textContent).not.toContain('escrow');
    await unmount();
  });

  it('amber banner is role=alert and states the direct-cost fall-through with reasons', async () => {
    const { container, unmount } = await render(
      React.createElement(EligibilityVerdictBanner, {
        verdict: 'fallthrough',
        reasons: ['no approved wallet', 'expired'],
      }),
    );
    const banner = container.querySelector('.v10-pca-verdict-banner')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.getAttribute('aria-live')).toBe('assertive');
    // P2-interim — the amber copy must HEDGE (attempt + fails-below-fee), not assert
    // the direct-cost publish will go through.
    expect(banner.textContent).toContain('attempt to pay the direct cost');
    expect(banner.textContent).toContain('fails if that TRAC is below the fee');
    expect(banner.textContent).not.toContain('it will pay the direct cost');
    expect(banner.textContent).toContain('no approved wallet');
    expect(banner.textContent).toContain('expired');
    await unmount();
  });

  it('adds the escrow caveat ONLY on owner-publishes (#4)', async () => {
    const owner = await render(
      React.createElement(EligibilityVerdictBanner, {
        verdict: 'fallthrough',
        ownerPublish: true,
      }),
    );
    expect(owner.container.querySelector('.v10-pca-verdict-banner')?.textContent).toContain('escrow');
    await owner.unmount();

    const sponsored = await render(
      React.createElement(EligibilityVerdictBanner, {
        verdict: 'fallthrough',
        ownerPublish: false,
      }),
    );
    expect(sponsored.container.querySelector('.v10-pca-verdict-banner')?.textContent).not.toContain(
      'escrow',
    );
    await sponsored.unmount();
  });

  it('danger banner (#6 no-TRAC fall-through) says the publish will FAIL and is role=alert', async () => {
    const { container, unmount } = await render(
      React.createElement(EligibilityVerdictBanner, {
        verdict: 'fallthrough-no-funds',
        reasons: ['no approved wallet'],
      }),
    );
    const banner = container.querySelector('.v10-pca-verdict-banner')!;
    expect(banner.classList.contains('v10-pca-verdict-danger')).toBe(true);
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.getAttribute('aria-live')).toBe('assertive');
    expect(banner.textContent).toContain('will FAIL');
    // Q2 — source-agnostic lead (no TRAC OR no gas); the specific cause is in reasonText.
    expect(banner.textContent).toContain('no signing wallet can cover it');
    expect(banner.textContent).toContain('no approved wallet');
    await unmount();
  });

  // F9 — amber + danger name the forfeited discount when it's in context.
  it('amber/danger banners name the forfeited discount when discountBps is in context (F9)', async () => {
    const amber = await render(
      React.createElement(EligibilityVerdictBanner, { verdict: 'fallthrough', accountId: '2', discountBps: 3000 }),
    );
    expect(amber.container.querySelector('.v10-pca-verdict-banner')?.textContent).toContain('forfeiting PCA #2’s −30%');
    await amber.unmount();

    const danger = await render(
      React.createElement(EligibilityVerdictBanner, { verdict: 'fallthrough-no-funds', accountId: '2', discountBps: 3000 }),
    );
    expect(danger.container.querySelector('.v10-pca-verdict-banner')?.textContent).toContain('forfeiting PCA #2’s −30%');
    await danger.unmount();

    // No discount in context → no fabricated forfeit clause.
    const noDisc = await render(React.createElement(EligibilityVerdictBanner, { verdict: 'fallthrough' }));
    expect(noDisc.container.querySelector('.v10-pca-verdict-banner')?.textContent).not.toContain('forfeiting');
    await noDisc.unmount();
  });

  it('danger banner adds the escrow caveat only on owner-publishes', async () => {
    const owner = await render(
      React.createElement(EligibilityVerdictBanner, {
        verdict: 'fallthrough-no-funds',
        ownerPublish: true,
      }),
    );
    expect(owner.container.querySelector('.v10-pca-verdict-banner')?.textContent).toContain('escrow');
    await owner.unmount();

    const sponsored = await render(
      React.createElement(EligibilityVerdictBanner, { verdict: 'fallthrough-no-funds' }),
    );
    expect(
      sponsored.container.querySelector('.v10-pca-verdict-banner')?.textContent,
    ).not.toContain('escrow');
    await sponsored.unmount();
  });

  it('danger chip reads "Publish will fail" and is role=alert', async () => {
    const { container, unmount } = await render(
      React.createElement(EligibilityVerdictBanner, {
        verdict: 'fallthrough-no-funds',
        variant: 'chip',
      }),
    );
    const label = container.querySelector('.v10-pca-verdict-chip-label')!;
    expect(label.getAttribute('role')).toBe('alert');
    expect(label.textContent).toContain('Publish will fail');
    const chip = container.querySelector('.v10-pca-verdict-chip')!;
    expect(chip.getAttribute('data-testid')).toBe('pca-eligibility-chip'); // e2e anchor
    expect(chip.classList.contains('v10-pca-verdict-danger')).toBe(true);
    await unmount();
  });

  it('neutral banner reads "couldn\'t confirm" and never renders as green', async () => {
    const { container, unmount } = await render(
      React.createElement(EligibilityVerdictBanner, { verdict: 'unknown' }),
    );
    const banner = container.querySelector('.v10-pca-verdict-banner')!;
    expect(banner.classList.contains('v10-pca-verdict-neutral')).toBe(true);
    expect(banner.classList.contains('v10-pca-verdict-green')).toBe(false);
    expect(banner.textContent?.toLowerCase()).toContain("couldn’t confirm");
    await unmount();
  });

  it('chip variant carries the verdict text + an aria-expanded "why?" disclosure', async () => {
    const onWhy = vi.fn();
    const { container, unmount } = await render(
      React.createElement(EligibilityVerdictBanner, {
        verdict: 'fallthrough',
        variant: 'chip',
        onWhy,
        whyExpanded: false,
        controlsId: 's5-popover',
      }),
    );
    const label = container.querySelector('.v10-pca-verdict-chip-label')!;
    expect(label.getAttribute('role')).toBe('alert');
    expect(label.textContent).toContain('No PCA discount');
    const why = container.querySelector('.v10-pca-verdict-why')!;
    expect(why.getAttribute('aria-expanded')).toBe('false');
    expect(why.getAttribute('aria-controls')).toBe('s5-popover');
    why.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onWhy).toHaveBeenCalled();
    await unmount();
  });
});

describe('SponsorshipHandshake', () => {
  it('renders both halves: the wallets to share and the account id to return', async () => {
    const { container, unmount } = await render(
      React.createElement(SponsorshipHandshake, {
        wallets: ['0xaaa1111111111111111111111111111111111111', '0xbbb2222222222222222222222222222222222222'],
        accountId: '7',
        role: 'edge',
      }),
    );
    expect(container.querySelectorAll('.v10-pca-wallet-row').length).toBe(2);
    expect(container.querySelector('.v10-pca-handshake-account-id')?.textContent).toBe('PCA #7');
    expect(container.querySelector('.v10-pca-handshake-copyall')).toBeTruthy();
    await unmount();
  });

  it('shows a pending placeholder for the account id before the sponsor returns it', async () => {
    const { container, unmount } = await render(
      React.createElement(SponsorshipHandshake, { wallets: ['0xaaa1111111111111111111111111111111111111'] }),
    );
    expect(container.querySelector('.v10-pca-handshake-account-id')).toBeNull();
    expect(container.textContent?.toLowerCase()).toContain('pending');
    await unmount();
  });
});

describe('EmptyState warning tone (A3)', () => {
  it('accepts the new "warning" tone and resolves the --text-warning accent', async () => {
    const { container, unmount } = await render(
      React.createElement(EmptyState, { title: 'Publishing at the direct cost', tone: 'warning' }),
    );
    const el = container.querySelector('.v10-empty-state')!;
    expect(el.getAttribute('data-tone')).toBe('warning');
    expect((el as HTMLElement).style.getPropertyValue('--v10-empty-accent')).toBe('var(--text-warning)');
    await unmount();
  });
});

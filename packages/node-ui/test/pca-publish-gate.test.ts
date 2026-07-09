// Pure unit test for the SWM→VM publish-blocked predicate (#1382 / OWAaO). No store, no
// poll, no DOM — just the decision as a function of a resolved eligibility.

import { describe, expect, it } from 'vitest';
import { pcaPublishBlocked } from '../src/ui/pca/publishGate.js';
import type { PublishEligibility } from '../src/ui/hooks/usePublishEligibility.js';

const elig = (over: Partial<PublishEligibility>): PublishEligibility =>
  ({
    verdict: 'unknown',
    loading: false,
    ownerPublish: false,
    anyGasFunded: false,
    reasons: [],
    conditions: { approved: false, gasFunded: false, notExpired: false, solvent: false },
    wallets: [],
    ...over,
  }) as PublishEligibility;

describe('pcaPublishBlocked (pure gate predicate — #1382)', () => {
  it('BLOCKS fallthrough-no-funds when there is no owner-escrow-with-gas escape', () => {
    // No owner → blocked regardless of gas.
    expect(pcaPublishBlocked(elig({ verdict: 'fallthrough-no-funds', ownerPublish: false, anyGasFunded: true }))).toBe(true);
    // Owner but every wallet out of gas → escrow covers TRAC not gas → still blocked.
    expect(pcaPublishBlocked(elig({ verdict: 'fallthrough-no-funds', ownerPublish: true, anyGasFunded: false }))).toBe(true);
  });

  it('does NOT block an owner publish with a gas-funded wallet (escrow may cover the TRAC fee)', () => {
    expect(pcaPublishBlocked(elig({ verdict: 'fallthrough-no-funds', ownerPublish: true, anyGasFunded: true }))).toBe(false);
  });

  it.each(['eligible', 'fallthrough', 'unknown'] as const)(
    'never blocks a %s verdict (any owner/gas permutation)',
    (verdict) => {
      expect(pcaPublishBlocked(elig({ verdict, ownerPublish: false, anyGasFunded: false }))).toBe(false);
      expect(pcaPublishBlocked(elig({ verdict, ownerPublish: true, anyGasFunded: true }))).toBe(false);
    },
  );
});

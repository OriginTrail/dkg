// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { promoteDormantContextGraphSubscriptions } from '../src/context-graph-subscription-authority-recovery.js';
import { createRollingPromotionFixture as createPromotionHarness, promotionSubscription } from './_helpers/rolling-subscription-promotion.js';

describe('rolling activation commit fences', () => {
    it('reconciles rolling promotion races and retry outcomes', async () => {
      const inactive = {
        ...createPromotionHarness([]).agent,
        store: undefined, getStatus: () => null, isCurrent: () => false,
        config: { contextGraphSubscriptionStore: undefined },
        contextGraphSubscriptionRehydrationStatus: null,
        contextGraphSubscriptionRehydrationPromotionRuntime: undefined,
        started: false,
      };
      await expect(
        promoteDormantContextGraphSubscriptions(
          inactive,
          new AbortController().signal,
        ),
      ).resolves.toBe('idle');

      const missing = createPromotionHarness([{ id: 'missing' }], {
        load: async () => null,
      });
      await expect(
        promoteDormantContextGraphSubscriptions(
          missing.agent,
          new AbortController().signal,
        ),
      ).resolves.toBe('idle');
      expect(missing.agent.contextGraphSubscriptionRehydrationPendingIds.size).toBe(0);
      expect(missing.agent.recordContextGraphSubscriptionClear)
        .toHaveBeenCalledWith(['missing']);

      const revoked = createPromotionHarness([{ id: 'revoked', subscribed: false, coreHosted: false }]);
      await promoteDormantContextGraphSubscriptions(
        revoked.agent,
        new AbortController().signal,
      );
      expect(revoked.agent.recordContextGraphSubscriptionClear)
        .toHaveBeenCalledWith([], ['revoked']);

      const alreadyActive = createPromotionHarness([{ id: 'already-active', subscribed: true }]);
      alreadyActive.agent.commitLiveIntent('already-active', promotionSubscription({ subscribed: true }));
      await promoteDormantContextGraphSubscriptions(
        alreadyActive.agent,
        new AbortController().signal,
      );
      expect(alreadyActive.agent.activatePersistedContextGraphSubscriptionRecord).not.toHaveBeenCalled();
      expect(alreadyActive.agent.contextGraphSubscriptionRehydrationPendingIds.size).toBe(0);

      for (const authority of ['denied', 'unavailable'] as const) {
        const blocked = createPromotionHarness([{ id: `blocked-${authority}`, subscribed: true }], { authority });
        await promoteDormantContextGraphSubscriptions(
          blocked.agent,
          new AbortController().signal,
        );
        expect(blocked.agent.log.warn).toHaveBeenCalled();
        expect(blocked.agent.contextGraphSubscriptionDormancyById.get(`blocked-${authority}`))
          .toBe(authority === 'denied' ? 'authorityDenied' : 'authorityUnavailable');
      }

      let reread = 0;
      const stale = createPromotionHarness([{ id: 'stale' }], {
        load: async () => (++reread === 1 ? { id: 'stale', subscribed: true } : null),
      });
      await promoteDormantContextGraphSubscriptions(
        stale.agent,
        new AbortController().signal,
      );
      expect(stale.agent.recordContextGraphSubscriptionClear)
        .toHaveBeenCalledWith(['stale']);

      let currentBinding = {
        id: 'binding-race',
        subscribed: true,
        onChainId: '7',
        onChainHash: `0x${'aa'.repeat(32)}`,
      };
      const laterEligible = {
        id: 'later-eligible',
        subscribed: true,
        onChainId: '8',
      };
      let enterAuthority!: () => void;
      let releaseAuthority!: () => void;
      const authorityEntered = new Promise<void>((resolve) => { enterAuthority = resolve; });
      const authorityGate = new Promise<void>((resolve) => { releaseAuthority = resolve; });
      const bindingRace = createPromotionHarness([currentBinding, laterEligible], {
        load: async (id) => ({ ...(id === currentBinding.id ? currentBinding : laterEligible) }),
      });
      bindingRace.agent.resolveContextGraphSubscriptionBootstrapAuthority
        .mockImplementation(async (id: string) => {
          if (id === currentBinding.id) {
            enterAuthority();
            await authorityGate;
          }
          return {
            outcome: 'allowed',
            source: 'registered-chain',
            reason: 'open-context-graph',
            metadataBootstrap: 'eligible',
            onChainId: 7n,
          } as const;
        });
      const racedPromotion = promoteDormantContextGraphSubscriptions(
          bindingRace.agent,
          new AbortController().signal,
        );
      await authorityEntered;
      currentBinding = {
        ...currentBinding,
        onChainHash: `0x${'bb'.repeat(32)}`,
      };
      releaseAuthority();
      await expect(racedPromotion).resolves.toBe('rearm');
      expect(bindingRace.agent.activatePersistedContextGraphSubscriptionRecord)
        .toHaveBeenCalledOnce();
      expect(bindingRace.agent.activatePersistedContextGraphSubscriptionRecord)
        .toHaveBeenCalledWith(expect.objectContaining(laterEligible), expect.any(Object));
      expect(bindingRace.agent.contextGraphSubscriptionRehydrationPendingIds)
        .toContain('binding-race');

      const activationFailure = createPromotionHarness([{ id: 'activation-failure', subscribed: true }], {
        activate: async () => { throw new Error('activation failed'); },
      });
      await expect(
        promoteDormantContextGraphSubscriptions(
          activationFailure.agent,
          new AbortController().signal,
        ),
      ).resolves.toBe('rearm');
      expect(activationFailure.agent.log.warn).toHaveBeenCalled();

      const batch = createPromotionHarness(
        Array.from({ length: 8 }, (_, i) => ({ id: `batch-${i}`, subscribed: true })),
        { cap: 9 },
      );
      await expect(
        promoteDormantContextGraphSubscriptions(
          batch.agent,
          new AbortController().signal,
        ),
      ).resolves.toBe('idle');
      expect(batch.agent.activatePersistedContextGraphSubscriptionRecord).toHaveBeenCalledTimes(8);
      expect(batch.agent.contextGraphSubscriptionRehydrationPendingIds.size).toBe(0);
    });

    it('fences capped promotion after authority and across strict binding repair', async () => {
      const reclassified = createPromotionHarness([
        { id: 'reclassified-after-authority', subscribed: true, onChainId: '7' },
      ]);
      reclassified.agent.resolveContextGraphSubscriptionBootstrapAuthority
        .mockImplementation(async (contextGraphId: string) => {
          reclassified.agent.contextGraphSubscriptionDormancyById
            .set(contextGraphId, 'authorityUnavailable');
          return {
            outcome: 'allowed',
            source: 'registered-chain',
            reason: 'open-context-graph',
            metadataBootstrap: 'eligible',
            onChainId: 7n,
          };
        });
      await expect(
        promoteDormantContextGraphSubscriptions(
          reclassified.agent,
          new AbortController().signal,
        ),
      ).resolves.toBe('rearm');
      expect(reclassified.agent.activatePersistedContextGraphSubscriptionRecord)
        .not.toHaveBeenCalled();

      // Flags installed during preparation do not confer committed activation.
      const concurrentlyInstalling = createPromotionHarness([
        { id: 'active-after-authority', subscribed: true, onChainId: '7' },
      ]);
      concurrentlyInstalling.agent.resolveContextGraphSubscriptionBootstrapAuthority
        .mockImplementation(async (contextGraphId: string) => {
          concurrentlyInstalling.agent.subscribedContextGraphs.set(contextGraphId, promotionSubscription({ subscribed: true }));
          return {
            outcome: 'allowed',
            source: 'registered-chain',
            reason: 'open-context-graph',
            metadataBootstrap: 'eligible',
            onChainId: 7n,
          };
        });
      await expect(
        promoteDormantContextGraphSubscriptions(
          concurrentlyInstalling.agent,
          new AbortController().signal,
        ),
      ).resolves.toBe('rearm');
      expect(concurrentlyInstalling.agent.activatePersistedContextGraphSubscriptionRecord)
        .not.toHaveBeenCalled();
      expect(concurrentlyInstalling.agent.contextGraphSubscriptionRehydrationPendingIds.size)
        .toBe(1);
      expect(concurrentlyInstalling.agent.contextGraphSubscriptionDormancyById.size).toBe(1);

      const staleBeforePrepare = createPromotionHarness([
        { id: 'stale-before-prepare', subscribed: true, onChainId: '7' },
      ]);
      staleBeforePrepare.agent.activatePersistedContextGraphSubscriptionRecord
        .mockImplementation(async (row: any, options: any) => {
          const subscription = promotionSubscription({ subscribed: true, onChainId: row.onChainId });
          staleBeforePrepare.agent.subscribedContextGraphs.set(row.id, subscription);
          staleBeforePrepare.agent.contextGraphSubscriptionDormancyById
            .set(row.id, 'authorityUnavailable');
          await options.prepare(subscription, vi.fn());
          return subscription;
        });
      await expect(
        promoteDormantContextGraphSubscriptions(
          staleBeforePrepare.agent,
          new AbortController().signal,
        ),
      ).resolves.toBe('rearm');
      expect(staleBeforePrepare.agent.log.warn).not.toHaveBeenCalled();
      expect(staleBeforePrepare.agent.reconcileRfc64CatalogResponsibilityV1).not.toHaveBeenCalled();
      expect(staleBeforePrepare.agent.activated).not.toHaveBeenCalled();
      expect(staleBeforePrepare.agent.contextGraphSubscriptionDormancyById.get('stale-before-prepare'))
        .toBe('authorityUnavailable');

      const staleDuringRepair = createPromotionHarness([
        { id: 'stale-during-repair', subscribed: true, onChainId: '042' },
      ]);
      staleDuringRepair.agent.resolveContextGraphSubscriptionBootstrapAuthority
        .mockResolvedValue({
          outcome: 'allowed',
          source: 'registered-chain',
          reason: 'open-context-graph',
          metadataBootstrap: 'eligible',
          onChainId: 8n,
        });
      const staleDuringRepairNetworkEffects = vi.fn();
      staleDuringRepair.agent.persistContextGraphSubscriptionStrict
        .mockImplementation(async (contextGraphId: string) => {
          await Promise.resolve();
          staleDuringRepair.agent.contextGraphSubscriptionPersistRevisions
            .set(contextGraphId, 1);
        });
      staleDuringRepair.agent.activatePersistedContextGraphSubscriptionRecord
        .mockImplementation(async (row: any, options: any) => {
          const subscription = promotionSubscription({ subscribed: true, onChainId: options.onChainId });
          staleDuringRepair.agent.subscribedContextGraphs.set(row.id, subscription);
          await options.prepare(subscription, (isCurrent: () => boolean) =>
            staleDuringRepair.agent.persistContextGraphSubscriptionStrict(row.id, subscription, row.syncScoped, isCurrent));
          if (!options.isCurrent(subscription)) throw new Error('stale activation');
          staleDuringRepairNetworkEffects();
          return subscription;
        });
      await expect(
        promoteDormantContextGraphSubscriptions(
          staleDuringRepair.agent,
          new AbortController().signal,
        ),
      ).resolves.toBe('rearm');
      expect(staleDuringRepair.agent.persistContextGraphSubscriptionStrict)
        .toHaveBeenCalledOnce();
      expect(staleDuringRepair.agent.reconcileRfc64CatalogResponsibilityV1)
        .not.toHaveBeenCalled();
      expect(staleDuringRepairNetworkEffects).not.toHaveBeenCalled();
      expect(staleDuringRepair.agent.contextGraphSubscriptionRehydrationPendingIds)
        .toContain('stale-during-repair');
      expect(staleDuringRepair.agent.log.warn).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('became stale'),
      );
    });

});

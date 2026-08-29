import { describe, expect, it, vi } from 'vitest';

import {
  Rfc64SwmRecoveryCoordinatorV1,
  type Rfc64AuthorizedSwmRecoveryPlanV1,
  type Rfc64SwmRecoveryAdmissionPortV1,
  type Rfc64SwmRecoveryCoordinatorDependenciesV1,
} from '../src/rfc64/swm-recovery-coordinator-v1.js';

const PROVIDER = '12D3KooWRfc64CoordinatorProvider';
const PUBLIC = 'rfc64-public';
const PRIVATE = '0x1111111111111111111111111111111111111111/rfc64-private';

function mixedPlan() {
  return {
    providerPeerId: PROVIDER,
    targets: [
      { contextGraphId: PUBLIC, lane: 'selected-public' as const },
      { contextGraphId: PRIVATE, lane: 'ordinary-private' as const },
    ],
  };
}

function dependencies(
  overrides: Partial<Rfc64SwmRecoveryAdmissionPortV1> = {},
): Rfc64SwmRecoveryCoordinatorDependenciesV1 {
  return {
    admission: {
      selectedPublicContextGraphIds: () => [PUBLIC],
      requestSelectedPublicAdmission: vi.fn(() => true),
      refreshSelectedPublicAdmission: vi.fn(() => true),
      selectedPublicAdmissionSnapshot: () => ({
        contextGraphIds: [PUBLIC],
        phase: 'retry-required',
      }),
      configuredRecoveryPlan: (providerPeerId) => providerPeerId === PROVIDER
        ? mixedPlan()
        : { providerPeerId, targets: [] },
      isCatalogReady: () => true,
      isPeerAccepted: () => true,
      isStarted: () => true,
      ...overrides,
    },
  };
}

describe('RFC-64 SWM recovery authorization', () => {
  it('admits one immutable mixed-provider plan', () => {
    const deps = dependencies();
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(deps);

    expect(coordinator.authorize(mixedPlan())).toEqual({
      kind: 'rfc64-authorized-swm-recovery-v1',
      providerPeerId: PROVIDER,
      targets: [
        { contextGraphId: PRIVATE, lane: 'ordinary-private' },
        { contextGraphId: PUBLIC, lane: 'selected-public' },
      ],
    });
    expect(deps.admission.requestSelectedPublicAdmission).toHaveBeenCalledOnce();
    expect(deps.admission.requestSelectedPublicAdmission).toHaveBeenCalledWith(
      PROVIDER,
      [PUBLIC],
    );
  });

  it('blocks every recovery authorization until the catalog phase is ready', () => {
    let catalogReady = false;
    const requestSelectedPublicAdmission = vi.fn(() => true);
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(dependencies({
      isCatalogReady: () => catalogReady,
      requestSelectedPublicAdmission,
    }));

    expect(coordinator.admitSelectedPublic(PROVIDER, [PUBLIC])).toBe(false);
    expect(coordinator.authorize(mixedPlan())).toBeNull();
    expect(requestSelectedPublicAdmission).not.toHaveBeenCalled();
    catalogReady = true;
    expect(coordinator.admitSelectedPublic(PROVIDER, [PUBLIC])).toBe(true);
    expect(requestSelectedPublicAdmission).toHaveBeenCalledOnce();
    expect(requestSelectedPublicAdmission).toHaveBeenCalledWith(PROVIDER, [PUBLIC]);
    expect(coordinator.authorize(mixedPlan())).not.toBeNull();
    expect(requestSelectedPublicAdmission).toHaveBeenCalledTimes(2);
  });

  it('combines catalog-pass refresh and mixed-plan authorization behind catalog readiness', () => {
    let catalogReady = false;
    const refreshSelectedPublicAdmission = vi.fn(() => true);
    const requestSelectedPublicAdmission = vi.fn(() => {
      throw new Error('catalog-pass authorization must not perform a second admission mutation');
    });
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(dependencies({
      isCatalogReady: () => catalogReady,
      refreshSelectedPublicAdmission,
      requestSelectedPublicAdmission,
    }));

    expect(coordinator.authorizeForCatalogPass(mixedPlan(), 10_000)).toBeNull();
    expect(refreshSelectedPublicAdmission).not.toHaveBeenCalled();
    catalogReady = true;
    expect(coordinator.authorizeForCatalogPass(mixedPlan(), 10_000)).toEqual({
      kind: 'rfc64-authorized-swm-recovery-v1',
      providerPeerId: PROVIDER,
      targets: [
        { contextGraphId: PRIVATE, lane: 'ordinary-private' },
        { contextGraphId: PUBLIC, lane: 'selected-public' },
      ],
    });
    expect(refreshSelectedPublicAdmission).toHaveBeenCalledWith(
      PROVIDER,
      [PUBLIC],
      10_000,
    );
    expect(refreshSelectedPublicAdmission).toHaveBeenCalledOnce();
    expect(requestSelectedPublicAdmission).not.toHaveBeenCalled();
  });

  it('retains an ordinary-private target when catalog-pass public refresh is suppressed', () => {
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(dependencies({
      refreshSelectedPublicAdmission: vi.fn(() => false),
    }));

    expect(coordinator.authorizeForCatalogPass(mixedPlan(), 10_000)).toEqual({
      kind: 'rfc64-authorized-swm-recovery-v1',
      providerPeerId: PROVIDER,
      targets: [{ contextGraphId: PRIVATE, lane: 'ordinary-private' }],
    });
  });

  it('drops a terminal public scope while retaining the same provider private lane', () => {
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(dependencies({
      requestSelectedPublicAdmission: vi.fn(() => false),
    }));

    expect(coordinator.authorize(mixedPlan())).toEqual({
      kind: 'rfc64-authorized-swm-recovery-v1',
      providerPeerId: PROVIDER,
      targets: [{ contextGraphId: PRIVATE, lane: 'ordinary-private' }],
    });
  });

  it('rejects an unselected public plan without mutating public admission', () => {
    const requestSelectedPublicAdmission = vi.fn(() => true);
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(dependencies({
      requestSelectedPublicAdmission,
      selectedPublicContextGraphIds: () => [],
    }));

    expect(coordinator.authorize({
      providerPeerId: PROVIDER,
      targets: [{ contextGraphId: PUBLIC, lane: 'selected-public' }],
    })).toBeNull();
    expect(requestSelectedPublicAdmission).not.toHaveBeenCalled();
  });

  it('rejects a private target not owned by the configured provider', () => {
    const requestSelectedPublicAdmission = vi.fn(() => true);
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(dependencies({
      requestSelectedPublicAdmission,
      configuredRecoveryPlan: (providerPeerId) => ({ providerPeerId, targets: [] }),
    }));

    expect(coordinator.authorize({
      providerPeerId: PROVIDER,
      targets: [{ contextGraphId: PRIVATE, lane: 'ordinary-private' }],
    })).toBeNull();
    expect(requestSelectedPublicAdmission).not.toHaveBeenCalled();
  });

  it('revalidates one authorized mixed plan against current configuration', () => {
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(dependencies());
    const authorized = coordinator.authorize(mixedPlan());
    expect(authorized).not.toBeNull();

    expect(coordinator.revalidate(authorized!)).toEqual({
      kind: 'rfc64-authorized-swm-recovery-v1',
      providerPeerId: PROVIDER,
      targets: [
        { contextGraphId: PRIVATE, lane: 'ordinary-private' },
        { contextGraphId: PUBLIC, lane: 'selected-public' },
      ],
    });
  });

  it('revalidates multiple public graphs with one locale-independent ordering', () => {
    const upper = 'B';
    const lower = 'a';
    const publicTargets = [upper, lower].map((contextGraphId) => ({
      contextGraphId,
      lane: 'selected-public' as const,
    }));
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(dependencies({
      selectedPublicContextGraphIds: () => [upper, lower],
      selectedPublicAdmissionSnapshot: () => ({
        contextGraphIds: [upper, lower],
        phase: 'retry-required',
      }),
      configuredRecoveryPlan: (providerPeerId) => ({
        providerPeerId,
        targets: publicTargets,
      }),
    }));
    const authorized = coordinator.authorize({
      providerPeerId: PROVIDER,
      targets: publicTargets,
    });

    expect(authorized).not.toBeNull();
    expect(() => coordinator.revalidate(authorized!)).not.toThrow();
  });

  it('fails closed when provider admission is revoked before execution', () => {
    let accepted = true;
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(dependencies({
      isPeerAccepted: () => accepted,
    }));
    const authorized = coordinator.authorize(mixedPlan());
    expect(authorized).not.toBeNull();
    accepted = false;

    expect(() => coordinator.revalidate(authorized!)).toThrow(
      'RFC-64 SWM recovery provider is not admitted or catalog-ready',
    );
  });

  it('fails closed when catalog readiness is revoked before execution', () => {
    let catalogReady = true;
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(dependencies({
      isCatalogReady: () => catalogReady,
    }));
    const authorized = coordinator.authorize(mixedPlan());
    expect(authorized).not.toBeNull();
    catalogReady = false;

    expect(() => coordinator.revalidate(authorized!)).toThrow(
      'RFC-64 SWM recovery provider is not admitted or catalog-ready',
    );
  });

  it('rejects forged authorized plans at the execution boundary', () => {
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(dependencies());
    const forgedPlans: readonly Rfc64AuthorizedSwmRecoveryPlanV1[] = [
      {
        kind: 'rfc64-authorized-swm-recovery-v1',
        providerPeerId: '12D3KooWUnconfiguredProvider',
        targets: mixedPlan().targets,
      },
      {
        kind: 'rfc64-authorized-swm-recovery-v1',
        providerPeerId: PROVIDER,
        targets: [{ contextGraphId: PUBLIC, lane: 'selected-public' }],
      },
      {
        kind: 'rfc64-authorized-swm-recovery-v1',
        providerPeerId: PROVIDER,
        targets: [
          { contextGraphId: PRIVATE, lane: 'selected-public' },
          { contextGraphId: PUBLIC, lane: 'selected-public' },
        ],
      },
    ];

    for (const forged of forgedPlans) {
      expect(() => coordinator.revalidate(forged)).toThrow(
        'RFC-64 SWM recovery plan is not authorized by current configuration',
      );
    }
  });
});

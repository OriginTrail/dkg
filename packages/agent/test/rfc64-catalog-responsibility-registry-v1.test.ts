// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  Rfc64CatalogResponsibilityRegistryV1,
  resolveRfc64CatalogResponsibilityReasonV1,
} from
  '../src/rfc64/catalog-responsibility-registry-v1.js';

describe('Rfc64CatalogResponsibilityRegistryV1', () => {
  it('defaults every lifecycle-responsible CG to catalog without a manifest', () => {
    const registry = new Rfc64CatalogResponsibilityRegistryV1();

    registry.setResponsibility('public-core', 'core-public');
    registry.setResponsibility('public-edge', 'edge-subscription');
    registry.setResponsibility('private-member', 'private-membership');

    expect(registry.snapshot()).toEqual([
      {
        contextGraphId: 'private-member',
        responsible: true,
        responsibilityReason: 'private-membership',
        active: true,
        mode: 'catalog',
        selectionSource: 'default',
      },
      {
        contextGraphId: 'public-core',
        responsible: true,
        responsibilityReason: 'core-public',
        active: true,
        mode: 'catalog',
        selectionSource: 'default',
      },
      {
        contextGraphId: 'public-edge',
        responsible: true,
        responsibilityReason: 'edge-subscription',
        active: true,
        mode: 'catalog',
        selectionSource: 'default',
      },
    ]);
  });

  it('keeps an unsubscribed edge and private nonmember outside the registry', () => {
    const registry = new Rfc64CatalogResponsibilityRegistryV1();

    expect(registry.read('unsubscribed-public')).toMatchObject({
      responsible: false,
      responsibilityReason: null,
      active: false,
      mode: 'catalog',
      selectionSource: 'default',
    });
    expect(registry.read('private-nonmember')).toMatchObject({
      responsible: false,
      responsibilityReason: null,
      active: false,
    });
    expect(registry.snapshot()).toEqual([]);
  });

  it('derives responsibility only from verified role and access facts', () => {
    expect(resolveRfc64CatalogResponsibilityReasonV1({
      nodeRole: 'edge',
      subscribed: true,
      coreHosted: false,
      accessPolicy: 'public',
      privateMembershipVerified: false,
    })).toBe('edge-subscription');
    expect(resolveRfc64CatalogResponsibilityReasonV1({
      nodeRole: 'core',
      subscribed: false,
      coreHosted: true,
      accessPolicy: null,
      privateMembershipVerified: false,
    })).toBe('core-public');
    expect(resolveRfc64CatalogResponsibilityReasonV1({
      nodeRole: 'edge',
      subscribed: true,
      coreHosted: false,
      accessPolicy: 'private',
      privateMembershipVerified: false,
    })).toBeNull();
    expect(resolveRfc64CatalogResponsibilityReasonV1({
      nodeRole: 'edge',
      subscribed: true,
      coreHosted: false,
      accessPolicy: 'private',
      privateMembershipVerified: true,
    })).toBe('private-membership');
    expect(resolveRfc64CatalogResponsibilityReasonV1({
      nodeRole: 'edge',
      subscribed: true,
      coreHosted: false,
      accessPolicy: null,
      privateMembershipVerified: true,
    })).toBeNull();
    expect(resolveRfc64CatalogResponsibilityReasonV1({
      nodeRole: 'core',
      subscribed: true,
      coreHosted: true,
      accessPolicy: 'private',
      privateMembershipVerified: true,
    })).toBeNull();
  });

  it('replaces and removes responsibility atomically', () => {
    const registry = new Rfc64CatalogResponsibilityRegistryV1();
    const entered = registry.setResponsibility('cg', 'edge-subscription');
    const replaced = registry.setResponsibility('cg', 'private-membership');
    const left = registry.setResponsibility('cg', null);

    expect(entered).toMatchObject({
      changed: true,
      previous: { responsible: false },
      next: { responsible: true, responsibilityReason: 'edge-subscription' },
    });
    expect(replaced).toMatchObject({
      changed: true,
      previous: { responsibilityReason: 'edge-subscription' },
      next: { responsibilityReason: 'private-membership' },
    });
    expect(left).toMatchObject({
      changed: true,
      previous: { responsible: true },
      next: { responsible: false, responsibilityReason: null },
    });
    expect(registry.snapshot()).toEqual([]);
  });

  it('retains explicit per-CG rollout modes as operator overrides', () => {
    const registry = new Rfc64CatalogResponsibilityRegistryV1({
      contextGraphModes: {
        legacy: 'legacy',
        shadow: 'shadow',
        explicitCatalog: 'catalog',
      },
    });
    registry.setResponsibility('legacy', 'edge-subscription');
    registry.setResponsibility('shadow', 'edge-subscription');
    registry.setResponsibility('explicitCatalog', 'edge-subscription');

    expect(registry.read('legacy')).toMatchObject({
      mode: 'legacy',
      selectionSource: 'operator-override',
      active: true,
    });
    expect(registry.read('shadow')).toMatchObject({
      mode: 'shadow',
      selectionSource: 'operator-override',
      active: true,
    });
    expect(registry.read('explicitCatalog')).toMatchObject({
      mode: 'catalog',
      selectionSource: 'operator-override',
      active: true,
    });

    const globallyDisabled = new Rfc64CatalogResponsibilityRegistryV1({
      defaultMode: 'legacy',
    });
    globallyDisabled.setResponsibility('disabled', 'edge-subscription');
    expect(globallyDisabled.read('disabled')).toMatchObject({
      mode: 'legacy',
      selectionSource: 'operator-override',
    });
  });

  it('makes the kill switch visible without silently changing the desired mode', () => {
    const registry = new Rfc64CatalogResponsibilityRegistryV1({
      killSwitchActive: true,
    });
    registry.setResponsibility('cg', 'edge-subscription');

    expect(registry.read('cg')).toEqual({
      contextGraphId: 'cg',
      responsible: true,
      responsibilityReason: 'edge-subscription',
      active: false,
      mode: 'catalog',
      selectionSource: 'kill-switch',
    });
  });

  it('snapshots controls and rejects malformed lifecycle facts', () => {
    const mutableModes = { cg: 'shadow' as const };
    const registry = new Rfc64CatalogResponsibilityRegistryV1({
      contextGraphModes: mutableModes,
    });
    mutableModes.cg = 'catalog' as 'shadow';
    registry.setResponsibility('cg', 'edge-subscription');

    expect(registry.read('cg').mode).toBe('shadow');
    expect(() => registry.setResponsibility('', 'edge-subscription')).toThrow(
      'contextGraphId must be a non-empty string',
    );
    expect(() => registry.setResponsibility('cg', 'unknown' as never)).toThrow(
      'Unknown RFC-64 responsibility reason',
    );
    expect(() => new Rfc64CatalogResponsibilityRegistryV1({
      contextGraphModes: { cg: 'invalid' as never },
    })).toThrow('must be legacy, shadow, or catalog');
  });
});

// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import type { Rfc64CatalogOperationalStatusV1 } from '../src/dkg-agent-rfc64-catalog.js';
import {
  RFC64_DAEMON_CERTIFICATION_STATUS_SCHEMA_V1,
  createRfc64DaemonCertificationStatusV1,
  decodeRfc64DaemonCertificationStatusV1,
  type CreateRfc64DaemonCertificationStatusInputV1,
} from '../src/rfc64/daemon-certification-status-v1.js';

const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/testnet-canary';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const CATALOG_DIGEST = `0x${'ab'.repeat(32)}`;
const INVENTORY_DIGEST = `0x${'cd'.repeat(32)}`;

describe('RFC-64 daemon certification status v1', () => {
  it('projects and decodes the narrow healthy daemon contract', () => {
    const projected = createRfc64DaemonCertificationStatusV1(input());

    expect(projected).toEqual({
      schema: RFC64_DAEMON_CERTIFICATION_STATUS_SCHEMA_V1,
      commit: COMMIT,
      networkId: 'otp-testnet-2160',
      syncReconcilerEnabled: true,
      chain: { configured: true, rpcEndpointCount: 3, chainId: '2160' },
      catalog: {
        enabled: true,
        killSwitch: false,
        contextGraphModes: { [CONTEXT_GRAPH_ID]: 'catalog' },
        contextGraphs: [certificationOperational()],
      },
    });
    expect(decodeRfc64DaemonCertificationStatusV1(projected)).toBe(projected);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.chain)).toBe(true);
    expect(Object.isFrozen(projected.catalog)).toBe(true);
    expect(Object.isFrozen(projected.catalog.contextGraphModes)).toBe(true);
    expect(Object.isFrozen(projected.catalog.contextGraphs)).toBe(true);
    expect(Object.isFrozen(projected.catalog.contextGraphs[0])).toBe(true);
  });

  it('preserves representable blocked/incomplete state and null chain metadata', () => {
    const blocked = mutable(createRfc64DaemonCertificationStatusV1(input({ chain: null })));
    blocked.catalog.contextGraphs[0] = {
      ...blocked.catalog.contextGraphs[0],
      phase: 'blocked',
      authorityState: 'blocked',
      authorityFreshness: null,
      expectedCatalogHeadDigest: null,
      appliedCatalogHeadDigest: null,
      expectedInventoryDigest: null,
      appliedInventoryDigest: null,
      expectedRowCount: null,
      appliedRowCount: null,
      missingRowCount: null,
      catalogVersion: null,
      lastSuccessfulAdvanceAt: null,
    };

    expect(decodeRfc64DaemonCertificationStatusV1(blocked)).toBe(blocked);
    expect(blocked.chain).toBeNull();
    expect(blocked.catalog.contextGraphs[0]).toMatchObject({
      phase: 'blocked',
      authorityState: 'blocked',
      authorityFreshness: null,
    });
  });

  it('decodes distinct internally complete snapshots without conflating final drift', () => {
    const source = mutable(createRfc64DaemonCertificationStatusV1(input()));
    const receiver = mutable(createRfc64DaemonCertificationStatusV1(input()));
    source.catalog.contextGraphs[0].expectedCatalogHeadDigest = `0x${'ef'.repeat(32)}`;
    source.catalog.contextGraphs[0].appliedCatalogHeadDigest = `0x${'ef'.repeat(32)}`;
    source.catalog.contextGraphs[0].catalogVersion = '8';

    expect(decodeRfc64DaemonCertificationStatusV1(source)).toBe(source);
    expect(decodeRfc64DaemonCertificationStatusV1(receiver)).toBe(receiver);
    expect(source.catalog.contextGraphs[0]).not.toEqual(receiver.catalog.contextGraphs[0]);
  });

  it('rejects malformed containers, scalars, enums, cursor values, and duplicates', () => {
    const cases: Array<[string, unknown]> = [
      ['root', null],
      ['schema', changed('schema', 'wrong')],
      ['commit', changed('commit', 1)],
      ['network ID', changed('networkId', 1)],
      ['sync flag', changed('syncReconcilerEnabled', 'yes')],
      ['chain container', changed('chain', [])],
      ['chain configured', changed('chain.configured', 'yes')],
      ['RPC count', changed('chain.rpcEndpointCount', '3')],
      ['chain ID', changed('chain.chainId', 2160)],
      ['catalog container', changed('catalog', [])],
      ['catalog enabled', changed('catalog.enabled', 'yes')],
      ['kill switch', changed('catalog.killSwitch', 'no')],
      ['mode map container', changed('catalog.contextGraphModes', [])],
      ['empty mode key', changed('catalog.contextGraphModes', { '': 'catalog' })],
      ['configured mode', changed(`catalog.contextGraphModes.${CONTEXT_GRAPH_ID}`, 'off')],
      ['operational array', changed('catalog.contextGraphs', {})],
      ['operational container', changed('catalog.contextGraphs.0', [])],
      ['empty context graph ID', changed('catalog.contextGraphs.0.contextGraphId', '')],
      ['effective mode', changed('catalog.contextGraphs.0.effectiveMode', 'off')],
      ['legacy flag', changed('catalog.contextGraphs.0.legacySyncAllowed', 'no')],
      ['phase', changed('catalog.contextGraphs.0.phase', 'stale')],
      ['authority state', changed('catalog.contextGraphs.0.authorityState', 'stale')],
      ['authority freshness', changed('catalog.contextGraphs.0.authorityFreshness', 'stale')],
      ['service flag', changed('catalog.contextGraphs.0.catalogServiceStarted', 'yes')],
      ['cursor scalar', changed('catalog.contextGraphs.0.catalogVersion', 7)],
      ['duplicate CG', duplicateContextGraph()],
    ];

    for (const [label, value] of cases) {
      expect(
        () => decodeRfc64DaemonCertificationStatusV1(value),
        label,
      ).toThrowError(/Invalid RFC-64 daemon certification status/u);
    }
  });
});

function input(
  overrides: Partial<CreateRfc64DaemonCertificationStatusInputV1> = {},
): CreateRfc64DaemonCertificationStatusInputV1 {
  return {
    commit: COMMIT,
    networkId: 'otp-testnet-2160',
    syncReconcilerEnabled: true,
    chain: { configured: true, rpcEndpointCount: 3, chainId: 2160 },
    catalog: {
      enabled: true,
      killSwitch: false,
      contextGraphModes: { [CONTEXT_GRAPH_ID]: 'catalog' },
      contextGraphs: [operational()],
    },
    ...overrides,
  };
}

function operational(): Rfc64CatalogOperationalStatusV1 {
  return {
    contextGraphId: CONTEXT_GRAPH_ID,
    responsibilityReason: 'edge-subscription',
    selectionSource: 'default',
    effectiveMode: 'catalog',
    accessPolicy: 0,
    publishPolicy: 0,
    legacySyncAllowed: false,
    phase: 'complete',
    authorityState: 'accepted',
    policySource: 'compatibility-seed',
    policyDigest: CATALOG_DIGEST,
    authorityEra: '1' as Rfc64CatalogOperationalStatusV1['authorityEra'],
    authorityFreshness: 'current',
    catalogServiceStarted: true,
    expectedCatalogHeadDigest: CATALOG_DIGEST as Rfc64CatalogOperationalStatusV1['expectedCatalogHeadDigest'],
    appliedCatalogHeadDigest: CATALOG_DIGEST as Rfc64CatalogOperationalStatusV1['appliedCatalogHeadDigest'],
    expectedInventoryDigest: INVENTORY_DIGEST as Rfc64CatalogOperationalStatusV1['expectedInventoryDigest'],
    appliedInventoryDigest: INVENTORY_DIGEST as Rfc64CatalogOperationalStatusV1['appliedInventoryDigest'],
    expectedRowCount: '2',
    appliedRowCount: '2',
    missingRowCount: '0',
    legacyReadOnlyCount: 0,
    catalogVersion: '7' as Rfc64CatalogOperationalStatusV1['catalogVersion'],
    authorHeadCount: 1,
    lastSuccessfulAdvanceAt: '1893456000' as Rfc64CatalogOperationalStatusV1['lastSuccessfulAdvanceAt'],
    providerHealth: {
      candidateCount: 1,
      attempts: 1,
      switches: 0,
      successes: 1,
      backoffMs: 0,
    },
    stableReason: null,
  };
}

function certificationOperational() {
  const status = operational();
  return {
    contextGraphId: status.contextGraphId,
    effectiveMode: status.effectiveMode,
    legacySyncAllowed: status.legacySyncAllowed,
    phase: status.phase,
    authorityState: status.authorityState,
    authorityFreshness: status.authorityFreshness,
    catalogServiceStarted: status.catalogServiceStarted,
    expectedCatalogHeadDigest: status.expectedCatalogHeadDigest,
    appliedCatalogHeadDigest: status.appliedCatalogHeadDigest,
    expectedInventoryDigest: status.expectedInventoryDigest,
    appliedInventoryDigest: status.appliedInventoryDigest,
    expectedRowCount: status.expectedRowCount,
    appliedRowCount: status.appliedRowCount,
    missingRowCount: status.missingRowCount,
    catalogVersion: status.catalogVersion,
    lastSuccessfulAdvanceAt: status.lastSuccessfulAdvanceAt,
  };
}

function changed(path: string, value: unknown): unknown {
  const status = mutable(createRfc64DaemonCertificationStatusV1(input()));
  const segments = path.split('.');
  let target: Record<string, unknown> = status as unknown as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    target = target[segment] as Record<string, unknown>;
  }
  target[segments.at(-1)!] = value;
  return status;
}

function duplicateContextGraph(): unknown {
  const status = mutable(createRfc64DaemonCertificationStatusV1(input()));
  status.catalog.contextGraphs.push({ ...status.catalog.contextGraphs[0] });
  return status;
}

function mutable<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}

type Mutable<T> = T extends readonly (infer V)[]
  ? Mutable<V>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

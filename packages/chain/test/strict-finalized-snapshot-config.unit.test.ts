import { describe, expect, it } from 'vitest';

import type { ChainIdV1 } from '@origintrail-official/dkg-core';

import {
  snapshotStrictCurrentFinalizedEvmConfigV1,
  snapshotStrictFinalizedSnapshotConfigV1,
} from '../src/strict-current-finalized-evm-config.js';

const CHAIN_ID = '20430' as ChainIdV1;
const ENDPOINT = 'https://rpc.example.test/';

/**
 * The snapshot wrapper must not weaken the strict plain-data config contract it
 * wraps. The ordering is the contract: an accessor-backed field is rejected
 * WITHOUT its getter ever running.
 *
 * This is a regression suite. An earlier revision destructured
 * `{ owner, ...rest }` before validating, which both executed enumerable getters
 * on the caller's object and converted them into plain data properties — so the
 * descriptor check downstream saw a clean object and ACCEPTED a config the base
 * validator rejects untouched.
 */
function accessorBackedConfig(field: 'chainId' | 'endpoints', counter: { runs: number }) {
  const config: Record<string, unknown> = {
    chainId: CHAIN_ID,
    endpoints: [ENDPOINT],
  };
  const value = config[field];
  delete config[field];
  Object.defineProperty(config, field, {
    enumerable: true,
    configurable: true,
    get() {
      counter.runs += 1;
      return value;
    },
  });
  return config;
}

describe('strict finalized snapshot config validation', () => {
  it.each(['chainId', 'endpoints'] as const)(
    'rejects an accessor-backed %s without invoking its getter',
    (field) => {
      const counter = { runs: 0 };
      expect(() =>
        snapshotStrictFinalizedSnapshotConfigV1(
          accessorBackedConfig(field, counter) as never,
        ),
      ).toThrow(/enumerable data properties/);
      // The count is the whole point. A wrapper that rejects only AFTER reading
      // has already run attacker-supplied code.
      expect(counter.runs).toBe(0);
    },
  );

  it('matches the base validator exactly on accessor inputs', () => {
    // Same input, same verdict, same zero reads — the wrapper must not be a
    // weaker door into the same room.
    const wrapped = { runs: 0 };
    const base = { runs: 0 };
    const wrappedError = (() => {
      try {
        snapshotStrictFinalizedSnapshotConfigV1(accessorBackedConfig('chainId', wrapped) as never);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    })();
    const baseError = (() => {
      try {
        snapshotStrictCurrentFinalizedEvmConfigV1(accessorBackedConfig('chainId', base) as never);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(wrappedError).not.toBeNull();
    expect(wrappedError).toBe(baseError);
    expect(wrapped.runs).toBe(0);
    expect(base.runs).toBe(0);
  });

  it('rejects an accessor-backed owner too', () => {
    let runs = 0;
    const config: Record<string, unknown> = { chainId: CHAIN_ID, endpoints: [ENDPOINT] };
    Object.defineProperty(config, 'owner', {
      enumerable: true,
      configurable: true,
      get() {
        runs += 1;
        return 'rfc64';
      },
    });
    expect(() => snapshotStrictFinalizedSnapshotConfigV1(config as never)).toThrow(
      /enumerable data properties/,
    );
    expect(runs).toBe(0);
  });

  it('rejects unknown fields rather than silently dropping them', () => {
    expect(() =>
      snapshotStrictFinalizedSnapshotConfigV1({
        chainId: CHAIN_ID,
        endpoints: [ENDPOINT],
        surprise: 1,
      } as never),
    ).toThrow(/unknown or missing fields/);
  });

  it('accepts the ordinary plain-data shapes, with and without owner', () => {
    expect(
      snapshotStrictFinalizedSnapshotConfigV1({ chainId: CHAIN_ID, endpoints: [ENDPOINT] }),
    ).toMatchObject({ chainId: CHAIN_ID, owner: 'foreground', blockReferenceProfile: 'eip1898' });
    expect(
      snapshotStrictFinalizedSnapshotConfigV1({
        chainId: CHAIN_ID,
        endpoints: [ENDPOINT],
        owner: 'w2-page',
      }),
    ).toMatchObject({ owner: 'w2-page' });
  });

  it('passes an explicit blockReferenceProfile through, and omits it when absent', () => {
    // The base allowlist rejects an explicit `undefined` key, so the rebuild must
    // add the key only when the caller actually set it.
    expect(
      snapshotStrictFinalizedSnapshotConfigV1({
        chainId: CHAIN_ID,
        endpoints: [ENDPOINT],
        blockReferenceProfile: 'trusted-block-number-hash-sandwich',
      }),
    ).toMatchObject({ blockReferenceProfile: 'trusted-block-number-hash-sandwich' });
    expect(
      snapshotStrictFinalizedSnapshotConfigV1({ chainId: CHAIN_ID, endpoints: [ENDPOINT] }),
    ).toMatchObject({ blockReferenceProfile: 'eip1898' });
  });
});

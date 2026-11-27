import { describe, expect, it } from 'vitest';
import { advertisedRelayAddress } from '../src/profile.js';

const SELF = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const RELAY_1 = '/ip4/198.51.100.1/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const RELAY_2 = '/dns4/relay-2.example.org/tcp/9090/p2p/12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ';
const RELAY_3 = '/ip4/198.51.100.3/tcp/9090/p2p/12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const circuitThrough = (relay: string) => `${relay}/p2p-circuit/p2p/${SELF}`;

describe('advertisedRelayAddress', () => {
  it('names the first configured relay the node holds a reservation on', () => {
    expect(advertisedRelayAddress([RELAY_1, RELAY_2, RELAY_3], [circuitThrough(RELAY_3), circuitThrough(RELAY_2)]))
      .toBe(RELAY_2);
  });

  it('recognises the relay by its peer id, whatever address the circuit came through', () => {
    const relay2Elsewhere = '/ip4/198.51.100.2/tcp/9090/p2p/12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ';
    expect(advertisedRelayAddress([RELAY_1, `${RELAY_2}/`], ['/ip4/198.51.100.20/tcp/4001', circuitThrough(relay2Elsewhere)]))
      .toBe(`${RELAY_2}/`);
  });

  it('falls back to the first configured relay while no reservation shows', () => {
    expect(advertisedRelayAddress([RELAY_1, RELAY_2], [])).toBe(RELAY_1);
    expect(advertisedRelayAddress([RELAY_1, RELAY_2], ['/ip4/198.51.100.20/tcp/4001', `/p2p-circuit/p2p/${SELF}`]))
      .toBe(RELAY_1);
    expect(advertisedRelayAddress(['/ip4/198.51.100.9/tcp/9090'], [circuitThrough(RELAY_3)])).toBe('/ip4/198.51.100.9/tcp/9090');
    expect(advertisedRelayAddress(undefined, [circuitThrough(RELAY_1)])).toBeUndefined();
    expect(advertisedRelayAddress([], [circuitThrough(RELAY_1)])).toBeUndefined();
  });
});

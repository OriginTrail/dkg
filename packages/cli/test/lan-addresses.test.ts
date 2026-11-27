import { describe, expect, it } from 'vitest';
import { resolveLanAddressesEnabled, resolvePublicAddressesOnly } from '../src/lan-addresses.js';

const PUBLIC_RELAY = '/ip4/198.51.100.1/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const DNS_RELAY = '/dns4/relay.example.org/tcp/9090/p2p/12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ';
const LOCAL_RELAY = '/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const LAN_RELAY = '/ip4/192.168.1.5/tcp/9090/p2p/12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';

describe('resolveLanAddressesEnabled', () => {
  it('is off by default and takes a boolean from the config', () => {
    expect(resolveLanAddressesEnabled(undefined, undefined)).toBe(false);
    expect(resolveLanAddressesEnabled(true, undefined)).toBe(true);
    expect(resolveLanAddressesEnabled(false, undefined)).toBe(false);
  });

  it('lets DKG_LAN_ADDRESSES_ENABLED win', () => {
    expect(resolveLanAddressesEnabled(false, '1')).toBe(true);
    expect(resolveLanAddressesEnabled(true, 'false')).toBe(false);
  });

  it('refuses a value it cannot read instead of guessing', () => {
    expect(() => resolveLanAddressesEnabled('yes', undefined)).toThrow('lanAddressesEnabled must be a boolean');
    expect(() => resolveLanAddressesEnabled(undefined, 'on')).toThrow('DKG_LAN_ADDRESSES_ENABLED must be one of 1, 0, true, or false');
  });
});

describe('resolvePublicAddressesOnly', () => {
  it('holds for an Edge whose relays are all public', () => {
    expect(resolvePublicAddressesOnly({ lanAddressesEnabled: false, role: 'edge', relayPeers: [PUBLIC_RELAY, DNS_RELAY] }))
      .toBe(true);
  });

  it('does not hold for a Core, with LAN addresses enabled, without relays, or with a local or LAN relay', () => {
    expect(resolvePublicAddressesOnly({ lanAddressesEnabled: false, role: 'core', relayPeers: [PUBLIC_RELAY] })).toBe(false);
    expect(resolvePublicAddressesOnly({ lanAddressesEnabled: true, role: 'edge', relayPeers: [PUBLIC_RELAY] })).toBe(false);
    expect(resolvePublicAddressesOnly({ lanAddressesEnabled: false, role: 'edge', relayPeers: undefined })).toBe(false);
    expect(resolvePublicAddressesOnly({ lanAddressesEnabled: false, role: 'edge', relayPeers: [] })).toBe(false);
    expect(resolvePublicAddressesOnly({ lanAddressesEnabled: false, role: 'edge', relayPeers: [PUBLIC_RELAY, LOCAL_RELAY] }))
      .toBe(false);
    expect(resolvePublicAddressesOnly({ lanAddressesEnabled: false, role: 'edge', relayPeers: [LAN_RELAY] })).toBe(false);
  });
});

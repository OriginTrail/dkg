// relay-public-reachability.test.ts
//
// 2026-07-07 Gnosis mainnet regression: a public Core Node's relay watchdog
// never obtained a client-side circuit reservation (`0 /p2p-circuit
// self-addrs`) and so `close()` + redialed its sibling-core connections on
// every grace-window expiry — churning the exact peers StorageACK streams run
// over, aborting in-flight ACK responses (empty replies the publisher then
// mislabeled as INVALID_SIGNATURE). The fix gates the reservation-forcing
// branch on `nodeHasDirectPublicAddress`: a directly-dialable node needs no
// client reservation, so it keeps its relay connections instead of thrashing
// them. This pins that predicate.
import { describe, it, expect } from 'vitest';
import { nodeHasDirectPublicAddress } from '../src/node.js';

const CORE = '178.104.101.41'; // oliwav / dHfyz351, a real Gnosis mainnet core
const PEER = '12D3KooWL9gwurFAVhQguJVs8CpzuSbt2hom9jyNJ5oHdHfyz351';

describe('nodeHasDirectPublicAddress', () => {
  it('true for a direct public /ip4 self-address (mainnet core shape)', () => {
    expect(nodeHasDirectPublicAddress([`/ip4/${CORE}/tcp/9090/p2p/${PEER}`])).toBe(true);
  });

  it('true for a public /dns4 self-address', () => {
    expect(nodeHasDirectPublicAddress([`/dns4/core.example.org/tcp/9090/p2p/${PEER}`])).toBe(true);
  });

  it('false for a circuit self-address only (reachable ONLY through a relay = NAT\'d)', () => {
    // A /p2p-circuit self-addr is proof of the opposite — this node DOES need
    // its reservation, so the watchdog must keep maintaining it.
    expect(nodeHasDirectPublicAddress([
      `/ip4/198.51.100.7/tcp/9090/p2p/RELAY/p2p-circuit/p2p/${PEER}`,
    ])).toBe(false);
  });

  it('false for private / loopback / CGNAT-only addresses (a genuinely NAT\'d node)', () => {
    expect(nodeHasDirectPublicAddress([
      `/ip4/10.0.0.5/tcp/9090/p2p/${PEER}`,
      `/ip4/192.168.1.20/tcp/9090/p2p/${PEER}`,
      `/ip4/172.16.4.4/tcp/9090/p2p/${PEER}`,
      `/ip4/100.64.0.1/tcp/9090/p2p/${PEER}`,   // CGNAT
      `/ip4/127.0.0.1/tcp/9090/p2p/${PEER}`,
    ])).toBe(false);
  });

  it('true when a public direct address sits alongside circuit + private ones', () => {
    // Mixed set: the node has a public IP AND holds a circuit reservation and
    // has private LAN addrs. The public direct addr is decisive — it does not
    // need the circuit reservation, so the watchdog stops forcing it.
    expect(nodeHasDirectPublicAddress([
      `/ip4/10.0.0.5/tcp/9090/p2p/${PEER}`,
      `/ip4/198.51.100.7/tcp/9090/p2p/RELAY/p2p-circuit/p2p/${PEER}`,
      `/ip4/${CORE}/tcp/9090/p2p/${PEER}`,
    ])).toBe(true);
  });

  it('false for an empty address set (nothing advertised yet — do not assume public)', () => {
    expect(nodeHasDirectPublicAddress([])).toBe(false);
  });
});

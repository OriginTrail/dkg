import { describe, expect, it } from 'vitest';
import { parseCircuitRelayPeerIds } from '../src/relay-path.js';

const RELAY_A = '12D3KooWRelayA';
const REMOTE_A = '12D3KooWRemoteA';

describe('parseCircuitRelayPeerIds', () => {
  it('extracts relay and remote peer ids from a circuit address', () => {
    expect(
      parseCircuitRelayPeerIds(`/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_A}/p2p-circuit/p2p/${REMOTE_A}`),
    ).toEqual({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A });
  });

  it('extracts only the relay peer id from reservation-style circuit addresses', () => {
    expect(
      parseCircuitRelayPeerIds(`/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_A}/p2p-circuit`),
    ).toEqual({ relayPeerId: RELAY_A, remotePeerId: undefined });
  });

  it('does not classify direct addresses as relayed paths', () => {
    expect(parseCircuitRelayPeerIds(`/ip4/1.2.3.4/tcp/9090/p2p/${REMOTE_A}`)).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_PEER_BINDING_KIND_V1,
  AGENT_PEER_BINDING_SCHEMA_VERSION_V1,
  canonicalizeAgentPeerBindingSigningBytesV1,
  parseCanonicalLibp2pPeerIdV1,
  verifySignedAgentPeerBindingV1,
  type AgentPeerBindingPayloadV1,
  type EvmAddressV1,
} from '../src/index.js';

const PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const AGENT = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const SIGNATURE = `0x${'22'.repeat(65)}`;

function payload(overrides: Partial<AgentPeerBindingPayloadV1> = {}): AgentPeerBindingPayloadV1 {
  return {
    kind: AGENT_PEER_BINDING_KIND_V1,
    schemaVersion: AGENT_PEER_BINDING_SCHEMA_VERSION_V1,
    bindingVersion: '7',
    agentAddress: AGENT,
    peerId: parseCanonicalLibp2pPeerIdV1(PEER_ID),
    validFromMs: '1000',
    expiresAtMs: '2000',
    state: 'active',
    ...overrides,
  } as AgentPeerBindingPayloadV1;
}

describe('agent peer binding v1', () => {
  it('verifies the closed artifact through the exact wallet-signature seam', async () => {
    const input = { ...payload(), signature: SIGNATURE };
    const verifier = vi.fn(() => true);

    const verified = await verifySignedAgentPeerBindingV1(input, verifier);

    expect(verified).toEqual(input);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(verifier).toHaveBeenCalledWith(
      canonicalizeAgentPeerBindingSigningBytesV1(payload()),
      SIGNATURE,
      AGENT,
    );
  });

  it('binds state, high-water version, validity, wallet, and exact peer into signing bytes', () => {
    const baseline = canonicalizeAgentPeerBindingSigningBytesV1(payload());
    for (const changed of [
      payload({ bindingVersion: '8' as never }),
      payload({ state: 'revoked' }),
      payload({ validFromMs: '1001' as never }),
      payload({ expiresAtMs: '2001' as never }),
      payload({ agentAddress: '0x2222222222222222222222222222222222222222' as EvmAddressV1 }),
      payload({ peerId: parseCanonicalLibp2pPeerIdV1(
        '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh',
      ) }),
    ]) {
      expect(canonicalizeAgentPeerBindingSigningBytesV1(changed)).not.toEqual(baseline);
    }
  });

  it('rejects non-canonical peers, invalid windows, unknown fields, and invalid signatures', async () => {
    expect(() => parseCanonicalLibp2pPeerIdV1(` ${PEER_ID}`)).toThrow(/canonical|valid/);
    expect(() => canonicalizeAgentPeerBindingSigningBytesV1(payload({
      expiresAtMs: '1000' as never,
    }))).toThrow('greater than validFromMs');

    await expect(verifySignedAgentPeerBindingV1({
      ...payload(),
      signature: SIGNATURE,
      extra: true,
    }, () => true)).rejects.toThrow('unknown or missing fields');
    await expect(verifySignedAgentPeerBindingV1({
      ...payload(),
      signature: SIGNATURE,
    }, () => false)).rejects.toThrow('wallet signature is invalid');
  });
});

import { isPublicLikeAddress } from '@origintrail-official/dkg-core';
import { resolveBooleanEnvOverride } from './boolean-env-override.js';

const LAN_ADDRESSES_ENV = 'DKG_LAN_ADDRESSES_ENABLED';

/**
 * `lanAddressesEnabled` (config) keeps LAN and VPN addresses in use on an Edge
 * whose relays are all public. By default such an Edge announces only its
 * public and relay addresses, and it sends requests to a peer that announces
 * no public address over the relay circuit already open to it, without dialing
 * the peer's loopback, private (RFC 1918), shared (100.64/10), link-local or
 * unique-local addresses first. Set it true when nodes of the network reach
 * each other over a LAN or VPN. DKG_LAN_ADDRESSES_ENABLED (1, 0, true or false)
 * wins over the config. Default false.
 */
export function resolveLanAddressesEnabled(
  configValue: unknown,
  envValue: string | undefined = process.env[LAN_ADDRESSES_ENV],
): boolean {
  return resolveBooleanEnvOverride({
    envName: LAN_ADDRESSES_ENV,
    configName: 'lanAddressesEnabled',
    envValue,
    configValue,
    defaultValue: false,
  });
}

/**
 * Whether the node uses public and relay addresses only
 * (`DKGAgentConfig.publicAddressesOnly`): an Edge, which reaches the network
 * through its relays, whose relays are all public, unless LAN addresses are
 * enabled. A devnet's relays are local, so its nodes keep their local routes.
 */
export function resolvePublicAddressesOnly(input: {
  readonly lanAddressesEnabled: boolean;
  readonly role: 'core' | 'edge';
  readonly relayPeers: readonly string[] | undefined;
}): boolean {
  const relays = input.relayPeers ?? [];
  return !input.lanAddressesEnabled && input.role === 'edge'
    && relays.length > 0 && relays.every((relay) => isPublicLikeAddress(relay));
}

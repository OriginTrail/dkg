import type { ConnectionGater } from '@libp2p/interface';

type ConnectionGaterHookName = keyof ConnectionGater;

/**
 * A connection-gater fragment as the DKG isolation policies build it: any
 * subset of libp2p's hooks, each answering synchronously. Hooks accept the
 * libp2p argument types or anything wider (the policies only need
 * `toString()`).
 */
export type SyncConnectionGater = {
  [K in ConnectionGaterHookName]?: (...args: Parameters<NonNullable<ConnectionGater[K]>>) => boolean;
};

/**
 * How fragments combine for one hook:
 * - `deny-if-any`: the hook returns true (refuse) when ANY fragment does.
 * - `keep-if-all`: the hook returns true (keep) only when EVERY fragment does.
 */
export type ConnectionGaterHookPolicy = 'deny-if-any' | 'keep-if-all';

/**
 * The combination rule of every libp2p gater hook, declared rather than
 * inferred from its name. A `Record` over all `ConnectionGater` keys, so a hook
 * a libp2p upgrade adds fails to compile here until its semantics are chosen.
 */
export const CONNECTION_GATER_HOOK_POLICY: Readonly<Record<ConnectionGaterHookName, ConnectionGaterHookPolicy>> = {
  denyDialPeer: 'deny-if-any',
  denyDialMultiaddr: 'deny-if-any',
  denyInboundConnection: 'deny-if-any',
  denyOutboundConnection: 'deny-if-any',
  denyInboundEncryptedConnection: 'deny-if-any',
  denyOutboundEncryptedConnection: 'deny-if-any',
  denyInboundUpgradedConnection: 'deny-if-any',
  denyOutboundUpgradedConnection: 'deny-if-any',
  denyInboundRelayReservation: 'deny-if-any',
  denyOutboundRelayedConnection: 'deny-if-any',
  denyInboundRelayedConnection: 'deny-if-any',
  filterMultiaddrForPeer: 'keep-if-all',
};

type AnyGaterHook = (...args: unknown[]) => boolean;

/**
 * Combine independent gater fragments into the one gater libp2p accepts, so a
 * new isolation policy only adds a fragment instead of editing every hook.
 * Each hook follows {@link CONNECTION_GATER_HOOK_POLICY}:
 *
 * - `deny-if-any` (every `deny*` hook): fragments are consulted in the given
 *   order and the first denial short-circuits, so a later policy neither runs
 *   nor logs for a connection an earlier one already refused.
 * - `keep-if-all` (`filterMultiaddrForPeer`): an address is kept only when
 *   every fragment keeps it.
 *
 * Only the hooks the table declares are read (own or inherited), so a
 * fragment's other members, such as state its methods use, are never mistaken
 * for hooks. A hook no fragment provides stays undefined, which keeps libp2p's
 * own default for it (allow, or store every address). Combined hooks do not
 * depend on `this`: libp2p hands `filterMultiaddrForPeer` to the peer store
 * unbound.
 */
export function combineConnectionGaters(
  fragments: ReadonlyArray<SyncConnectionGater | undefined>,
): SyncConnectionGater {
  const present = fragments.filter((fragment): fragment is SyncConnectionGater => fragment !== undefined);
  const combined: Partial<Record<ConnectionGaterHookName, AnyGaterHook>> = {};
  for (const name of Object.keys(CONNECTION_GATER_HOOK_POLICY) as ConnectionGaterHookName[]) {
    const hooks = present.flatMap((fragment): AnyGaterHook[] => {
      const hook = fragment[name] as AnyGaterHook | undefined;
      return typeof hook === 'function' ? [(...args) => hook.apply(fragment, args)] : [];
    });
    if (hooks.length === 0) continue;
    combined[name] = CONNECTION_GATER_HOOK_POLICY[name] === 'keep-if-all'
      ? (...args) => hooks.every((hook) => hook(...args))
      : (...args) => hooks.some((hook) => hook(...args));
  }
  return combined as SyncConnectionGater;
}

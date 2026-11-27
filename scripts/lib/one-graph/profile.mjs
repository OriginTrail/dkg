// The node profile every Edge of the one-graph promotion suite
// (scripts/devnet-test-one-graph-promotion.mjs) runs: the config members and
// the environment of the deployment the suite stands for, and the relay-only
// recipe that leaves an Edge reachable through relays only. Pure: nothing
// here starts a node.

/** The profile's config.json members. */
export const PROFILE_CONFIG = Object.freeze({
  syncOnConnectEnabled: true,
  syncReconcilerEnabled: false,
  vmReconcilerEnabled: true,
  vmRecoveryPrefetchEnabled: true,
  durableSyncEnabled: true,
  syncGlobalMaxInflight: 1,
  syncGlobalQueueLimit: 0,
});

/** The profile's environment. */
export const PROFILE_ENV = Object.freeze({
  DKG_EXACT_BATCH_STREAM_ENABLED: '1',
  DKG_CATCHUP_MAX_CONCURRENT_PEERS: '1',
  DKG_STORE_QUEUE_WAIT_TIMEOUT_MS: '300000',
  DKG_SYNC_TOTAL_TIMEOUT_MS: '1800000',
  DKG_SWM_RECOVERY_TIMEOUT_MS: '3600000',
  DKG_STORE_QUEUE_LIMIT: '512',
});

/**
 * Variables that, when set, override a member of the profile's config or the
 * sync and relay behaviour beside it. The profile sets none of them, so every
 * Edge gets each one empty: the node reads an empty value as unset, and a
 * value inherited from whoever runs the suite cannot replace the profile.
 */
export const OVERRIDE_ENV = Object.freeze([
  'DKG_SYNC_ON_CONNECT_ENABLED',
  'DKG_SYNC_RECONCILER_ENABLED',
  'DKG_VM_RECONCILER_ENABLED',
  'DKG_VM_RECOVERY_PREFETCH_ENABLED',
  'DKG_DURABLE_SYNC_ENABLED',
  'DKG_SYNC_GLOBAL_MAX_INFLIGHT',
  'DKG_SYNC_GLOBAL_LIMIT',
  'DKG_SYNC_GLOBAL_QUEUE_LIMIT',
  'DKG_SYNC_SHARED_MEMORY_RESERVED_INFLIGHT',
  'DKG_RECENT_SHARED_MEMORY_PULL_ENABLED',
  'DKG_RELAY_PREFERRED',
]);

// Nobody listens on the discard port: a dial of it is refused at once.
export const DEAD_DIRECT_ADDRESS = '/ip4/127.0.0.1/tcp/9';

/**
 * An Edge's config overrides: the profile, and the relay-only recipe. The
 * Edge reserves a slot on every relay (`relay`, then `preferredRelays`), and
 * announces, in place of its listen address, a port nobody listens on and its
 * circuit address through each relay; it dials Cores directly, as an Edge
 * behind NAT does.
 */
export function edgeOverrides(relays) {
  if (!Array.isArray(relays) || relays.length === 0 || relays.some(relay => typeof relay !== 'string' || !relay)) {
    throw new Error('an Edge needs at least one relay multiaddr');
  }
  const [relay, ...preferred] = relays;
  return {
    ...PROFILE_CONFIG,
    relay,
    ...(preferred.length ? { preferredRelays: preferred } : {}),
    announceAddresses: [DEAD_DIRECT_ADDRESS, ...relays.map(address => `${address}/p2p-circuit`)],
  };
}

/** An Edge's daemon environment: the overriding variables emptied, then the profile's own. */
export function edgeEnv() {
  return { ...Object.fromEntries(OVERRIDE_ENV.map(name => [name, ''])), ...PROFILE_ENV };
}

/**
 * The DKG_* variables of the suite's own environment that every node of the
 * devnet inherits and the profile neither sets nor empties (DKG_AUTH, the
 * suite's admin token, aside). The run reports them: an Edge differs from the
 * profile by each one the node reads.
 */
export function inheritedDkgEnv(env) {
  return Object.keys(env ?? {})
    .filter(name => name.startsWith('DKG_') && name !== 'DKG_AUTH' && !(name in PROFILE_ENV) && !OVERRIDE_ENV.includes(name))
    .sort();
}

/** Every name of the profile, config members and variables alike, which the build must read. */
export const PROFILE_NAMES = Object.freeze([...Object.keys(PROFILE_CONFIG), ...Object.keys(PROFILE_ENV)]);

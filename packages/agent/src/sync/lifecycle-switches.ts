export interface SyncLifecycleSwitchConfig {
  syncReconcilerEnabled?: boolean;
  syncOnConnectEnabled?: boolean;
  durableSyncEnabled?: boolean;
}

export interface SyncLifecycleSwitches {
  syncReconcilerEnabled: boolean;
  syncOnConnectEnabled: boolean;
  durableSyncEnabled: boolean;
  warmCoreConnectionsEnabled: boolean;
}

export function parseBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on' || raw === 'enabled') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off' || raw === 'disabled') return false;
  return undefined;
}

export function resolveBooleanSwitch(
  configValue: boolean | undefined,
  envName: string,
  defaultValue: boolean,
): boolean {
  return parseBooleanEnv(envName) ?? configValue ?? defaultValue;
}

/** One agent-owned snapshot used by runtime gates and public status. */
export function resolveSyncLifecycleSwitches(
  config: SyncLifecycleSwitchConfig = {},
): SyncLifecycleSwitches {
  return {
    syncReconcilerEnabled: resolveBooleanSwitch(
      config.syncReconcilerEnabled,
      'DKG_SYNC_RECONCILER_ENABLED',
      true,
    ),
    syncOnConnectEnabled: resolveBooleanSwitch(
      config.syncOnConnectEnabled,
      'DKG_SYNC_ON_CONNECT_ENABLED',
      true,
    ),
    durableSyncEnabled: resolveBooleanSwitch(
      config.durableSyncEnabled,
      'DKG_DURABLE_SYNC_ENABLED',
      true,
    ),
    // Warm Core activation intentionally retains its original exact opt-in.
    warmCoreConnectionsEnabled: process.env.DKG_WARM_CORE_CONNECTIONS === '1',
  };
}

export function resolveSyncReconcilerEnabled(configValue?: boolean): boolean {
  return resolveSyncLifecycleSwitches({ syncReconcilerEnabled: configValue })
    .syncReconcilerEnabled;
}

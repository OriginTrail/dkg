import {
  STORAGE_ADAPTERS,
  isExternalBackend,
  isStorageAdapterBackend,
  type StorageAdapterBackend,
} from '@origintrail-official/dkg-storage';

/**
 * Operator-facing daemon policy composed on top of storage-owned adapter facts.
 *
 * This is the sole owner of daemon defaults, retired config names, migration
 * classification, menu visibility, and labels. Adapter endpoint/path metadata
 * is spread from `STORAGE_ADAPTERS` rather than duplicated here.
 */
export const STORE_BACKENDS = {
  'oxigraph-server': {
    kind: 'managed-local',
    adapter: false,
    retired: false,
    default: true,
    wizard: true,
    storeFlag: true,
    label: 'oxigraph-server  (managed local server — recommended)',
  },
  oxigraph: {
    ...STORAGE_ADAPTERS.oxigraph,
    adapter: true,
    retired: false,
    default: false,
    wizard: true,
    storeFlag: true,
    label: 'oxigraph         (embedded in-memory store — development only)',
  },
  'oxigraph-persistent': {
    ...STORAGE_ADAPTERS['oxigraph-persistent'],
    adapter: true,
    retired: false,
    default: false,
    wizard: false,
    storeFlag: false,
  },
  blazegraph: {
    ...STORAGE_ADAPTERS.blazegraph,
    adapter: true,
    retired: false,
    default: false,
    wizard: true,
    storeFlag: true,
    label: 'blazegraph       (external SPARQL endpoint)',
  },
  'sparql-http': {
    ...STORAGE_ADAPTERS['sparql-http'],
    adapter: true,
    retired: false,
    default: false,
    wizard: false,
    storeFlag: true,
  },
  'oxigraph-worker': {
    kind: 'retired',
    adapter: false,
    retired: true,
    default: false,
    wizard: false,
    storeFlag: false,
  },
} as const;

export type StoreBackend = keyof typeof STORE_BACKENDS;
export type StoreBackendPolicy = (typeof STORE_BACKENDS)[StoreBackend];
export type StoreBackendKind = StoreBackendPolicy['kind'];
export type StoreBackendOfKind<Kind extends StoreBackendKind> = {
  [Backend in StoreBackend]: typeof STORE_BACKENDS[Backend] extends { kind: Kind }
    ? Backend
    : never;
}[StoreBackend];
export type ConfigStoreBackend = {
  [Backend in StoreBackend]: typeof STORE_BACKENDS[Backend] extends { retired: false }
    ? Backend
    : never;
}[StoreBackend];
export type RetiredStoreBackend = {
  [Backend in StoreBackend]: typeof STORE_BACKENDS[Backend] extends { retired: true }
    ? Backend
    : never;
}[StoreBackend];
export type DefaultStoreBackend = {
  [Backend in StoreBackend]: typeof STORE_BACKENDS[Backend] extends { default: true }
    ? Backend
    : never;
}[StoreBackend];
export type WizardStoreBackend = {
  [Backend in StoreBackend]: typeof STORE_BACKENDS[Backend] extends { wizard: true }
    ? Backend
    : never;
}[StoreBackend];
export type StoreFlagBackend = {
  [Backend in StoreBackend]: typeof STORE_BACKENDS[Backend] extends { storeFlag: true }
    ? Backend
    : never;
}[StoreBackend];
export type ExternalStoreBackend = Extract<StoreBackendOfKind<'external'>, StorageAdapterBackend>;
export type LocalStoreBackend = Extract<StoreBackendOfKind<'local'>, StorageAdapterBackend>;
export type ManagedLocalStoreBackend = StoreBackendOfKind<'managed-local'>;

export function storeBackendNames(): StoreBackend[] {
  return Object.keys(STORE_BACKENDS) as StoreBackend[];
}

function requireSingleBackend<Backend extends StoreBackend>(
  backends: readonly Backend[],
  description: string,
): Backend {
  if (backends.length !== 1) {
    throw new Error(`Expected exactly one ${description} store backend, found ${backends.length}`);
  }
  return backends[0];
}

export const DEFAULT_DAEMON_STORE_BACKEND: DefaultStoreBackend = requireSingleBackend(
  storeBackendNames().filter(
    (backend): backend is DefaultStoreBackend => STORE_BACKENDS[backend].default,
  ),
  'default',
);

export const MANAGED_DAEMON_STORE_BACKEND: ManagedLocalStoreBackend = requireSingleBackend(
  storeBackendNames().filter(
    (backend): backend is ManagedLocalStoreBackend => STORE_BACKENDS[backend].kind === 'managed-local',
  ),
  'managed-local',
);

export const DEFAULT_STORE_BACKEND = DEFAULT_DAEMON_STORE_BACKEND;
export const MANAGED_LOCAL_STORE_BACKEND = MANAGED_DAEMON_STORE_BACKEND;

export function configBackendNames(): ConfigStoreBackend[] {
  return storeBackendNames().filter(
    (backend): backend is ConfigStoreBackend => !STORE_BACKENDS[backend].retired,
  );
}

export function retiredBackendNames(): RetiredStoreBackend[] {
  return storeBackendNames().filter(
    (backend): backend is RetiredStoreBackend => STORE_BACKENDS[backend].retired,
  );
}

export function configBackendList(separator = ', '): string {
  return configBackendNames().join(separator);
}

export function wizardBackendChoices(): WizardStoreBackend[] {
  return storeBackendNames().filter(
    (backend): backend is WizardStoreBackend =>
      !STORE_BACKENDS[backend].retired && STORE_BACKENDS[backend].wizard,
  );
}

export function storeFlagBackendNames(): StoreFlagBackend[] {
  return storeBackendNames().filter(
    (backend): backend is StoreFlagBackend =>
      !STORE_BACKENDS[backend].retired && STORE_BACKENDS[backend].storeFlag,
  );
}

export function storeFlagBackendList(separator = ', '): string {
  return storeFlagBackendNames().join(separator);
}

export function isKnownStoreBackend(
  backend: string | undefined | null,
): backend is StoreBackend {
  return backend != null && Object.prototype.hasOwnProperty.call(STORE_BACKENDS, backend);
}

export function getStoreBackendPolicy(
  backend: string | undefined | null,
): StoreBackendPolicy | undefined {
  return isKnownStoreBackend(backend) ? STORE_BACKENDS[backend] : undefined;
}

export function isConfigStoreBackend(
  backend: string | undefined | null,
): backend is ConfigStoreBackend {
  return isKnownStoreBackend(backend) && !STORE_BACKENDS[backend].retired;
}

export function isStoreFlagBackend(
  backend: string | undefined | null,
): backend is StoreFlagBackend {
  return isKnownStoreBackend(backend)
    && !STORE_BACKENDS[backend].retired
    && STORE_BACKENDS[backend].storeFlag;
}

export function isRetiredStoreBackend(
  backend: string | undefined | null,
): backend is RetiredStoreBackend {
  return isKnownStoreBackend(backend) && STORE_BACKENDS[backend].retired;
}

export function isManagedLocalBackend(
  backend: string | undefined | null,
): backend is ManagedLocalStoreBackend {
  return isKnownStoreBackend(backend) && STORE_BACKENDS[backend].kind === 'managed-local';
}

export function isExternalStoreBackend(
  backend: string | undefined | null,
): backend is ExternalStoreBackend {
  return isExternalBackend(backend);
}

/** Cross from daemon runtime config into the storage factory's adapter type. */
export function requireStorageAdapterBackend(backend: string): StorageAdapterBackend {
  if (!isStorageAdapterBackend(backend)) {
    throw new Error(
      `Daemon runtime store backend "${backend}" is not a constructible storage adapter`,
    );
  }
  return backend;
}

export { isStorageAdapterBackend };
export type { StorageAdapterBackend };

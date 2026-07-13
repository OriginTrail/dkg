/**
 * Canonical triple-store backend taxonomy.
 *
 * Keep backend classification here so storage adapters, daemon routing, config
 * validation, and CLI discovery all consume the same metadata. This module is
 * dependency-free and safe to import from every storage consumer.
 */
export const STORE_BACKENDS = {
  'oxigraph-server': {
    kind: 'managed-local',
    adapter: false,
    retired: false,
    default: true,
    menu: true,
    label: 'oxigraph-server  (managed local server — recommended)',
  },
  oxigraph: {
    kind: 'local',
    adapter: true,
    retired: false,
    default: false,
    menu: true,
    label: 'oxigraph         (embedded in-memory store — development only)',
    requiresExistingPath: false,
  },
  'oxigraph-persistent': {
    kind: 'local',
    adapter: true,
    retired: false,
    default: false,
    menu: false,
    requiresExistingPath: true,
  },
  blazegraph: {
    kind: 'external',
    adapter: true,
    retired: false,
    default: false,
    menu: true,
    label: 'blazegraph       (external SPARQL endpoint)',
    queryEndpointOption: 'url',
    updateEndpointOption: 'url',
  },
  'sparql-http': {
    kind: 'external',
    adapter: true,
    retired: false,
    default: false,
    menu: false,
    queryEndpointOption: 'queryEndpoint',
    updateEndpointOption: 'updateEndpoint',
    authOption: 'auth',
  },
  'oxigraph-worker': {
    kind: 'retired',
    adapter: false,
    retired: true,
    default: false,
    menu: false,
  },
} as const;

export type KnownStoreBackend = keyof typeof STORE_BACKENDS;
export type StoreBackendPolicy = (typeof STORE_BACKENDS)[KnownStoreBackend];
export type StoreBackendKind = StoreBackendPolicy['kind'];
export type StoreBackendOfKind<Kind extends StoreBackendKind> = {
  [Backend in KnownStoreBackend]: typeof STORE_BACKENDS[Backend] extends { kind: Kind }
    ? Backend
    : never;
}[KnownStoreBackend];
export type SupportedDaemonStoreBackend = {
  [Backend in KnownStoreBackend]: typeof STORE_BACKENDS[Backend] extends { retired: false }
    ? Backend
    : never;
}[KnownStoreBackend];
export type RetiredStoreBackend = {
  [Backend in KnownStoreBackend]: typeof STORE_BACKENDS[Backend] extends { retired: true }
    ? Backend
    : never;
}[KnownStoreBackend];
export type DefaultDaemonStoreBackend = {
  [Backend in KnownStoreBackend]: typeof STORE_BACKENDS[Backend] extends { default: true }
    ? Backend
    : never;
}[KnownStoreBackend];
export type MenuStoreBackend = {
  [Backend in KnownStoreBackend]: typeof STORE_BACKENDS[Backend] extends { menu: true }
    ? Backend
    : never;
}[KnownStoreBackend];
export type StorageAdapterBackend = {
  [Backend in KnownStoreBackend]: typeof STORE_BACKENDS[Backend] extends { adapter: true }
    ? Backend
    : never;
}[KnownStoreBackend];
export type ExternalStoreBackend = StoreBackendOfKind<'external'>;
export type LocalStoreBackend = StoreBackendOfKind<'local'>;
export type ManagedLocalStoreBackend = StoreBackendOfKind<'managed-local'>;

declare const CUSTOM_TRIPLE_STORE_BACKEND: unique symbol;
export type CustomTripleStoreBackend = string & {
  readonly [CUSTOM_TRIPLE_STORE_BACKEND]: true;
};

export type ClassifiedTripleStoreBackend =
  | { kind: 'adapter'; backend: StorageAdapterBackend }
  | { kind: 'managed-local'; backend: ManagedLocalStoreBackend }
  | { kind: 'retired'; backend: RetiredStoreBackend }
  | { kind: 'custom'; backend: CustomTripleStoreBackend };

export function storeBackendNames(): KnownStoreBackend[] {
  return Object.keys(STORE_BACKENDS) as KnownStoreBackend[];
}

function requireSingleBackend<Backend extends KnownStoreBackend>(
  backends: readonly Backend[],
  description: string,
): Backend {
  if (backends.length !== 1) {
    throw new Error(`Expected exactly one ${description} store backend, found ${backends.length}`);
  }
  return backends[0];
}

export const DEFAULT_DAEMON_STORE_BACKEND: DefaultDaemonStoreBackend = requireSingleBackend(
  storeBackendNames().filter(
    (backend): backend is DefaultDaemonStoreBackend => STORE_BACKENDS[backend].default,
  ),
  'default',
);

export const MANAGED_DAEMON_STORE_BACKEND: ManagedLocalStoreBackend = requireSingleBackend(
  storeBackendNames().filter(
    (backend): backend is ManagedLocalStoreBackend => STORE_BACKENDS[backend].kind === 'managed-local',
  ),
  'managed-local',
);

export function supportedBackendNames(): SupportedDaemonStoreBackend[] {
  return storeBackendNames().filter(
    (backend): backend is SupportedDaemonStoreBackend => !STORE_BACKENDS[backend].retired,
  );
}

export function retiredBackendNames(): RetiredStoreBackend[] {
  return storeBackendNames().filter(
    (backend): backend is RetiredStoreBackend => STORE_BACKENDS[backend].retired,
  );
}

export function supportedBackendList(separator = ', '): string {
  return supportedBackendNames().join(separator);
}

export function menuBackendChoices(): MenuStoreBackend[] {
  return storeBackendNames().filter(
    (backend): backend is MenuStoreBackend =>
      !STORE_BACKENDS[backend].retired && STORE_BACKENDS[backend].menu,
  );
}

export function isKnownStoreBackend(
  backend: string | undefined | null,
): backend is KnownStoreBackend {
  return backend != null && Object.prototype.hasOwnProperty.call(STORE_BACKENDS, backend);
}

export function getStoreBackendPolicy(
  backend: string | undefined | null,
): StoreBackendPolicy | undefined {
  return isKnownStoreBackend(backend) ? STORE_BACKENDS[backend] : undefined;
}

export function isSupportedStoreBackend(
  backend: string | undefined | null,
): backend is SupportedDaemonStoreBackend {
  return isKnownStoreBackend(backend) && !STORE_BACKENDS[backend].retired;
}

export function isRetiredStoreBackend(
  backend: string | undefined | null,
): backend is RetiredStoreBackend {
  return isKnownStoreBackend(backend) && STORE_BACKENDS[backend].retired;
}

export function isExternalBackend(
  backend: string | undefined | null,
): backend is ExternalStoreBackend {
  return isKnownStoreBackend(backend) && STORE_BACKENDS[backend].kind === 'external';
}

export function isManagedLocalBackend(
  backend: string | undefined | null,
): backend is ManagedLocalStoreBackend {
  return isKnownStoreBackend(backend) && STORE_BACKENDS[backend].kind === 'managed-local';
}

export function isStorageAdapterBackend(
  backend: string | undefined | null,
): backend is StorageAdapterBackend {
  return isKnownStoreBackend(backend) && STORE_BACKENDS[backend].adapter;
}

export function customTripleStoreBackend(backend: string): CustomTripleStoreBackend {
  if (!backend.trim()) throw new Error('Custom triple-store backend name cannot be empty');
  if (isKnownStoreBackend(backend)) {
    throw new Error(`Known triple-store backend "${backend}" does not need a custom-backend wrapper`);
  }
  return backend as CustomTripleStoreBackend;
}

export function classifyTripleStoreBackend(backend: string): ClassifiedTripleStoreBackend {
  if (!isKnownStoreBackend(backend)) {
    return { kind: 'custom', backend: backend as CustomTripleStoreBackend };
  }
  if (STORE_BACKENDS[backend].retired) {
    return { kind: 'retired', backend: backend as RetiredStoreBackend };
  }
  if (STORE_BACKENDS[backend].adapter) {
    return { kind: 'adapter', backend: backend as StorageAdapterBackend };
  }
  if (STORE_BACKENDS[backend].kind === 'managed-local') {
    return { kind: 'managed-local', backend: backend as ManagedLocalStoreBackend };
  }
  throw new Error(`Known store backend "${backend}" has no factory-boundary classification`);
}

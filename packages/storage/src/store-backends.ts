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
    retired: false,
    default: true,
    menu: true,
    label: 'oxigraph-server  (managed local server — recommended)',
  },
  oxigraph: {
    kind: 'local',
    retired: false,
    default: false,
    menu: true,
    label: 'oxigraph         (embedded in-memory store — development only)',
    requiresExistingPath: false,
  },
  'oxigraph-persistent': {
    kind: 'local',
    retired: false,
    default: false,
    menu: false,
    requiresExistingPath: true,
  },
  blazegraph: {
    kind: 'external',
    retired: false,
    default: false,
    menu: true,
    label: 'blazegraph       (external SPARQL endpoint)',
    queryEndpointOption: 'url',
    updateEndpointOption: 'url',
  },
  'sparql-http': {
    kind: 'external',
    retired: false,
    default: false,
    menu: false,
    queryEndpointOption: 'queryEndpoint',
    updateEndpointOption: 'updateEndpoint',
    authOption: 'auth',
  },
  'oxigraph-worker': {
    kind: 'retired',
    retired: true,
    default: false,
    menu: false,
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
export type SupportedStoreBackend = {
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
export type MenuStoreBackend = {
  [Backend in StoreBackend]: typeof STORE_BACKENDS[Backend] extends { menu: true }
    ? Backend
    : never;
}[StoreBackend];
export type ExternalStoreBackend = StoreBackendOfKind<'external'>;
export type LocalStoreBackend = StoreBackendOfKind<'local'>;
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

export const DEFAULT_STORE_BACKEND: DefaultStoreBackend = requireSingleBackend(
  storeBackendNames().filter(
    (backend): backend is DefaultStoreBackend => STORE_BACKENDS[backend].default,
  ),
  'default',
);

export const MANAGED_LOCAL_STORE_BACKEND: ManagedLocalStoreBackend = requireSingleBackend(
  storeBackendNames().filter(
    (backend): backend is ManagedLocalStoreBackend => STORE_BACKENDS[backend].kind === 'managed-local',
  ),
  'managed-local',
);

export function supportedBackendNames(): SupportedStoreBackend[] {
  return storeBackendNames().filter(
    (backend): backend is SupportedStoreBackend => !STORE_BACKENDS[backend].retired,
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
): backend is StoreBackend {
  return backend != null && Object.prototype.hasOwnProperty.call(STORE_BACKENDS, backend);
}

export function getStoreBackendPolicy(
  backend: string | undefined | null,
): StoreBackendPolicy | undefined {
  return isKnownStoreBackend(backend) ? STORE_BACKENDS[backend] : undefined;
}

export function isSupportedStoreBackend(
  backend: string | undefined | null,
): backend is SupportedStoreBackend {
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

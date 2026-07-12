export const STORE_BACKENDS = {
  'oxigraph-server': {
    kind: 'managed-local',
    retired: false,
    menu: true,
    label: 'oxigraph-server  (managed local server — recommended)',
  },
  oxigraph: {
    kind: 'local',
    retired: false,
    menu: true,
    label: 'oxigraph         (embedded in-memory store — development only)',
    requiresExistingPath: false,
  },
  'oxigraph-persistent': {
    kind: 'local',
    retired: false,
    menu: false,
    requiresExistingPath: true,
  },
  blazegraph: {
    kind: 'external',
    retired: false,
    menu: true,
    label: 'blazegraph       (external SPARQL endpoint)',
  },
  'sparql-http': {
    kind: 'external',
    retired: false,
    menu: false,
  },
  'oxigraph-worker': {
    kind: 'retired',
    retired: true,
    menu: false,
  },
} as const;

export type StoreBackend = keyof typeof STORE_BACKENDS;
export type SupportedStoreBackend = Exclude<StoreBackend, 'oxigraph-worker'>;
export type MenuStoreBackend = {
  [Backend in StoreBackend]: typeof STORE_BACKENDS[Backend] extends { menu: true }
    ? Backend
    : never;
}[StoreBackend];
export type ExternalStoreBackend = {
  [Backend in StoreBackend]: typeof STORE_BACKENDS[Backend] extends { kind: 'external' }
    ? Backend
    : never;
}[StoreBackend];

export const DEFAULT_STORE_BACKEND: SupportedStoreBackend = 'oxigraph-server';
export const UNSUPPORTED_WORKER_BACKEND: StoreBackend = 'oxigraph-worker';

export function storeBackendNames(): StoreBackend[] {
  return Object.keys(STORE_BACKENDS) as StoreBackend[];
}

export function supportedBackendNames(): SupportedStoreBackend[] {
  return storeBackendNames().filter((backend): backend is SupportedStoreBackend => (
    !STORE_BACKENDS[backend].retired
  ));
}

export function supportedBackendList(separator = ', '): string {
  return supportedBackendNames().join(separator);
}

export function menuBackendChoices(): MenuStoreBackend[] {
  return storeBackendNames().filter((backend): backend is MenuStoreBackend => (
    !STORE_BACKENDS[backend].retired && STORE_BACKENDS[backend].menu
  ));
}

export function isKnownStoreBackend(backend: string | undefined): backend is StoreBackend {
  return backend !== undefined && Object.prototype.hasOwnProperty.call(STORE_BACKENDS, backend);
}

export function isSupportedStoreBackend(backend: string | undefined): backend is SupportedStoreBackend {
  return isKnownStoreBackend(backend) && !STORE_BACKENDS[backend].retired;
}

export function isExternalStoreBackend(backend: string | undefined): backend is ExternalStoreBackend {
  return isKnownStoreBackend(backend) && STORE_BACKENDS[backend].kind === 'external';
}

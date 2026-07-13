/**
 * Canonical metadata for adapters the storage factory can construct.
 *
 * Daemon defaults, retired config names, migration policy, and CLI labels live
 * in the CLI package. Keeping this registry adapter-only prevents the storage
 * layer from acquiring daemon lifecycle or presentation policy.
 */
export const STORAGE_ADAPTERS = {
  oxigraph: {
    kind: 'local',
    requiresExistingPath: false,
  },
  'oxigraph-persistent': {
    kind: 'local',
    requiresExistingPath: true,
  },
  blazegraph: {
    kind: 'external',
    queryEndpointOption: 'url',
    updateEndpointOption: 'url',
  },
  'sparql-http': {
    kind: 'external',
    queryEndpointOption: 'queryEndpoint',
    updateEndpointOption: 'updateEndpoint',
    authOption: 'auth',
  },
} as const;

export type StorageAdapterBackend = keyof typeof STORAGE_ADAPTERS;
export type StorageAdapterPolicy = (typeof STORAGE_ADAPTERS)[StorageAdapterBackend];
export type StorageAdapterKind = StorageAdapterPolicy['kind'];
export type StorageAdapterOfKind<Kind extends StorageAdapterKind> = {
  [Backend in StorageAdapterBackend]: typeof STORAGE_ADAPTERS[Backend] extends { kind: Kind }
    ? Backend
    : never;
}[StorageAdapterBackend];
export type ExternalStoreBackend = StorageAdapterOfKind<'external'>;
export type LocalStoreBackend = StorageAdapterOfKind<'local'>;

declare const CUSTOM_TRIPLE_STORE_BACKEND: unique symbol;
export type CustomTripleStoreBackend = string & {
  readonly [CUSTOM_TRIPLE_STORE_BACKEND]: true;
};

export type ClassifiedTripleStoreBackend =
  | { kind: 'adapter'; backend: StorageAdapterBackend }
  | { kind: 'custom'; backend: CustomTripleStoreBackend };

export function storageAdapterNames(): StorageAdapterBackend[] {
  return Object.keys(STORAGE_ADAPTERS) as StorageAdapterBackend[];
}

export function isStorageAdapterBackend(
  backend: string | undefined | null,
): backend is StorageAdapterBackend {
  return backend != null && Object.prototype.hasOwnProperty.call(STORAGE_ADAPTERS, backend);
}

export function getStorageAdapterPolicy(
  backend: string | undefined | null,
): StorageAdapterPolicy | undefined {
  return isStorageAdapterBackend(backend) ? STORAGE_ADAPTERS[backend] : undefined;
}

export function isExternalBackend(
  backend: string | undefined | null,
): backend is ExternalStoreBackend {
  return isStorageAdapterBackend(backend) && STORAGE_ADAPTERS[backend].kind === 'external';
}

export function customTripleStoreBackend(backend: string): CustomTripleStoreBackend {
  if (!backend.trim()) throw new Error('Custom triple-store backend name cannot be empty');
  if (isStorageAdapterBackend(backend)) {
    throw new Error(`Known triple-store adapter "${backend}" does not need a custom-backend wrapper`);
  }
  return backend as CustomTripleStoreBackend;
}

export function classifyTripleStoreBackend(backend: string): ClassifiedTripleStoreBackend {
  return isStorageAdapterBackend(backend)
    ? { kind: 'adapter', backend }
    : { kind: 'custom', backend: backend as CustomTripleStoreBackend };
}

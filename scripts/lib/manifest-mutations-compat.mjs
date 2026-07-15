/**
 * Deprecated compatibility names for the removed selector-based manifest
 * mutation interface. New code must import the read-only helpers from
 * `manifest.mjs` and keep resumability state in an external durable store.
 */

export const ATOMIC_MANIFEST_UNSUPPORTED_CODE = 'KA_ATOMIC_MANIFEST_UNSUPPORTED';

function atomicManifestUnsupportedError() {
  const error = new Error(
    'The legacy resumable-import manifest is not compatible with atomic whole-KA sharing; use external durable state until the manifest is redesigned.',
  );
  error.code = ATOMIC_MANIFEST_UNSUPPORTED_CODE;
  return error;
}

/** @deprecated The legacy manifest mutation interface is unsupported. */
export async function createImportManifest() {
  throw atomicManifestUnsupportedError();
}

/** @deprecated The legacy manifest mutation interface is unsupported. */
export async function markPartitionStatus() {
  throw atomicManifestUnsupportedError();
}

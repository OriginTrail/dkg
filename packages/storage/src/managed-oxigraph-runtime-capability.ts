/**
 * Opaque, process-local proof that a SPARQL endpoint was created by the DKG
 * managed-Oxigraph supervisor. The WeakSet makes the authority nominal at
 * runtime: persisted JSON, object literals, and copied properties cannot
 * forge it.
 */
export interface ManagedOxigraphRuntimeCapabilityV1 {
  readonly kind: 'dkg-managed-oxigraph-runtime-v1';
}

const issuedCapabilities = new WeakSet<object>();

/** @internal Called only by the daemon after it has started the managed child. */
export function issueManagedOxigraphRuntimeCapabilityV1():
ManagedOxigraphRuntimeCapabilityV1 {
  const capability = Object.freeze({
    kind: 'dkg-managed-oxigraph-runtime-v1' as const,
  });
  issuedCapabilities.add(capability);
  return capability;
}

export function isManagedOxigraphRuntimeCapabilityV1(
  candidate: unknown,
): candidate is ManagedOxigraphRuntimeCapabilityV1 {
  return candidate !== null
    && typeof candidate === 'object'
    && issuedCapabilities.has(candidate);
}

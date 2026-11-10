/** Preserve installed profile bytes and pins while exposing the operation contract. */
export function legacyProfileOperations(profile) {
  if (['enabled', 'loadInputs', 'validateInput', 'validateNode', 'readRequest', 'readItems', 'evidence', 'transport']
    .some(key => typeof profile[key] !== 'function')) throw new Error('Invalid DKG execution profile.');
  const loadInputs = () => profile.loadInputs();
  const common = (id, kind) => ({ parameters: profile.parameters?.[id], sampleItems: profile.sampleItems?.[id],
    enabled: () => profile.enabled(id), loadInputs,
    validateInput: (...args) => profile.validateInput(...args), validateNode: (...args) => profile.validateNode(...args),
    transport: (payload, context) => profile.transport(payload, kind, context) });
  return {
    'dkg-read': { ...common('dkg-read', 'read'),
      readRequest: (...args) => profile.readRequest(...args), readItems: (...args) => profile.readItems(...args) },
    'invoke-dkg-program': { ...common('invoke-dkg-program', 'invoke'), programs: profile.programs, catalogRevision: profile.catalogRevision },
    'dkg-write': { ...common('dkg-write', 'write'), targetGraph: profile.targetGraph, evidence: (...args) => profile.evidence(...args) },
  };
}

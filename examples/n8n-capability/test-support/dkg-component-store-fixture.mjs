import { dkgComponentStore as createStore } from '../dkg-components.mjs';
import profile from '../profiles/jpb.mjs';
import { profileOperations } from '../dkg-profile.mjs';

export function withDkgTestDependencies(selectedProfile, { transport, approvedInputs } = {}) {
  if (!selectedProfile) return null;
  const loadInputs = approvedInputs == null ? undefined : () => structuredClone(approvedInputs);
  const kinds = { 'dkg-read': 'read', 'invoke-dkg-program': 'invoke', 'dkg-write': 'write' };
  return { ...selectedProfile, operations: Object.fromEntries(Object.entries(profileOperations(selectedProfile)).map(([id, operation]) =>
    [id, { ...operation, ...(loadInputs ? { loadInputs } : {}),
      ...(transport ? { transport: (payload, context) => transport(payload, kinds[id], context) } : {}) }])) };
}

// Journal unit tests model a verified native Receive input. Bridge/service tests
// independently supply provider execution snapshots through the actual route.
export function dkgComponentStore(db, transport, approvedInputs, selectedProfile = profile) {
  const store = createStore(db, withDkgTestDependencies(selectedProfile, { transport, approvedInputs })), { call, grant } = store;
  store.grant = (workflow, invocationId, input, actor) => grant(workflow,
    { invocationId, revisionDigest: workflow.sourceHash }, input, actor);
  store.call = (value, workflow, nativeId) => {
    const id = /^urn:sr:effect:([a-f0-9-]{36}):/.exec(value?.effectId ?? '')?.[1];
    const run = db.prepare('SELECT input FROM dkg_component_runs WHERE id=?').get(id ?? '');
    return call(value, workflow, { invocationId: id, revisionDigest: workflow.sourceHash }, nativeId,
      { invocationId: value?.effectId, input: run ? JSON.parse(run.input) : null });
  };
  return store;
}

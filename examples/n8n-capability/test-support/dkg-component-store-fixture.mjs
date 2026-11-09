import { dkgComponentStore as createStore } from '../dkg-components.mjs';

// Journal unit tests model a verified native Receive input. Bridge/service tests
// independently supply provider execution snapshots through the actual route.
export function dkgComponentStore(db, ...options) {
  const store = createStore(db, ...options), { call, grant } = store;
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

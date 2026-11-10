/** Trusted server-side profile selection. No built-in customer, endpoint or transport fallback. */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { legacyProfileOperations } from './dkg-profile-legacy.mjs';
export const dkgOperationIds = ['dkg-read', 'invoke-dkg-program', 'dkg-write'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hooks = ['enabled', 'validateInput', 'validateNode', 'transport'];
const runtimeProfiles = new WeakMap();
export const profileOperations = profile => requireDkgProfile(profile).operations;
export function validateDkgProfile(profile) {
  if (runtimeProfiles.has(profile)) return runtimeProfiles.get(profile);
  if (!profile || typeof profile.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(profile.id)
    || !/^[a-f0-9]{64}$/.test(profile.revision ?? '') || typeof profile.node !== 'string' || !profile.node
    || profile.requiresNosActor && (typeof profile.accountId !== 'string' || !profile.accountId || typeof profile.authorize !== 'function'))
    throw new Error('Invalid DKG execution profile.');
  const operations = profile.operations === undefined ? legacyProfileOperations(profile) : profile.operations;
  if (!record(operations) || !Object.keys(operations).length || Object.entries(operations).some(([id, operation]) =>
    !dkgOperationIds.includes(id) || !record(operation) || !record(operation.parameters)
    || hooks.some(key => typeof operation[key] !== 'function')
    || operation.loadInputs !== undefined && typeof operation.loadInputs !== 'function'
    || id === 'dkg-read' && ['readRequest', 'readItems'].some(key => typeof operation[key] !== 'function')
    || id === 'invoke-dkg-program' && (!Array.isArray(operation.programs) || typeof operation.catalogRevision !== 'string' || !operation.catalogRevision)
    || id === 'dkg-write' && (typeof operation.targetGraph !== 'string' || !operation.targetGraph || typeof operation.evidence !== 'function')))
    throw new Error('Invalid DKG operation capabilities.');
  let runtime = profile;
  if (profile.operations === undefined) {
    runtime = { operations, authorize: (...args) => profile.authorize(...args) };
    // Compatibility lives at construction. Identity and live authorization
    // metadata still follow the operator profile, as its dynamic hooks do.
    for (const key of ['id', 'revision', 'node', 'requiresNosActor', 'accountId', 'workflowTools'])
      Object.defineProperty(runtime, key, { enumerable: true, get: () => profile[key] });
  }
  runtimeProfiles.set(profile, runtime);
  runtimeProfiles.set(runtime, runtime);
  return runtime;
}
export async function loadDkgProfile(file, context = {}) {
  if (!file) return null;
  if (!isAbsolute(file)) throw new Error('NOS_DKG_PROFILE_MODULE must be an absolute operator-controlled module path.');
  const module = await import(pathToFileURL(file).href);
  return validateDkgProfile(module.createProfile ? await module.createProfile(context) : module.default);
}
export function requireDkgProfile(profile = null) {
  if (!profile) throw Object.assign(new Error('No DKG execution profile configured.'), { code: 'DKG_COMPONENT_UNCONFIRMED', status: 409 });
  return validateDkgProfile(profile);
}
export function profileParameters(profile, id) {
  return { ...requireDkgOperation(profile, id).parameters, profileRevision: { type: 'string', label: 'Execution profile revision',
    default: profile.revision, maxLength: 64, options: [profile.revision] } };
}
export function requireDkgOperation(profile, id) {
  const operations = requireDkgProfile(profile).operations;
  if (!Object.hasOwn(operations, id)) throw Object.assign(new Error(id + ' is not supported by this execution profile.'),
    { code: 'DKG_COMPONENT_UNCONFIRMED', status: 409 });
  return operations[id];
}

/** Trusted server-side profile selection. No built-in customer, endpoint or transport fallback. */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
export const dkgOperationIds = ['dkg-read', 'invoke-dkg-program', 'dkg-write'];
const hooks = ['enabled', 'loadInputs', 'validateInput', 'validateNode', 'readRequest', 'readItems', 'evidence', 'transport'];
export function validateDkgProfile(profile) {
  if (!profile || typeof profile.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(profile.id)
    || !/^[a-f0-9]{64}$/.test(profile.revision ?? '') || typeof profile.node !== 'string' || !profile.node
    || typeof profile.targetGraph !== 'string' || !profile.targetGraph || !Array.isArray(profile.programs)
    || typeof profile.catalogRevision !== 'string' || !profile.catalogRevision
    || hooks.some(key => typeof profile[key] !== 'function')
    || dkgOperationIds.some(id => !profile.parameters?.[id])) throw new Error('Invalid DKG execution profile.');
  return profile;
}
export async function loadDkgProfile(file) {
  if (!file) return null;
  if (!isAbsolute(file)) throw new Error('NOS_DKG_PROFILE_MODULE must be an absolute operator-controlled module path.');
  return validateDkgProfile((await import(pathToFileURL(file).href)).default);
}
export const configuredDkgProfile = await loadDkgProfile(process.env.NOS_DKG_PROFILE_MODULE);
export function requireDkgProfile(profile = configuredDkgProfile) {
  if (!profile) throw Object.assign(new Error('No DKG execution profile configured.'), { code: 'DKG_COMPONENT_UNCONFIRMED', status: 409 });
  return validateDkgProfile(profile);
}
export function profileParameters(profile, id) {
  return { ...profile.parameters[id], profileRevision: { type: 'string', label: 'Execution profile revision',
    default: profile.revision, maxLength: 64, options: [profile.revision] } };
}

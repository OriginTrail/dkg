/** One operator-owned profile and compiler per companion or provisioning run. */
import { loadDkgProfile } from './dkg-profile.mjs';
import { loadNosStudioSession } from './nos-studio-session.mjs';
import { createComponentRegistry } from './component-registry.mjs';
import { createStudioCompiler } from './studio-definition.mjs';

export function createStudioContext({ profile = null, session = null } = {}) {
  const registry = createComponentRegistry(profile);
  return Object.freeze({ session, profile: registry.profile, registry, compiler: createStudioCompiler(registry) });
}

export async function loadStudioContext(env = process.env) {
  const session = loadNosStudioSession(env.NOS_STUDIO_SESSION_FILE);
  const profile = await loadDkgProfile(env.NOS_DKG_PROFILE_MODULE, { session });
  return createStudioContext({ profile, session });
}

import { hashParts } from './semantic-runtime-values.js';

/** Identity shared by execution admission and delegated native callbacks. */
export function typeScriptInvocationIdentity(digest: string, caller: string, canonicalInputs: string, ancestors: string[] = []): string {
  return hashParts(['typescript-v1', digest, caller.toLowerCase(), canonicalInputs, ...ancestors]);
}

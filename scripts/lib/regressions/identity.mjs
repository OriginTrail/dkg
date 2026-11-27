import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function inside(root, file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || /[\0\r\n]/.test(file)) throw new Error('invalid repository-relative path');
  const resolved = path.resolve(root, file);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('path escapes repository');
  const real = fs.realpathSync(resolved);
  if (!real.startsWith(`${fs.realpathSync(root)}${path.sep}`)) throw new Error('symlink escapes repository');
  return resolved;
}
// What every receipt shares: the proof's CLI and the modules that run, classify
// and fingerprint a replay. Neither the register (profiles.mjs) nor the
// validator (registry.mjs) is here: they produce no evidence, and the selected
// case's own definition is fingerprinted with its receipt.
export const SHARED_EXECUTION_INPUTS = Object.freeze([
  'scripts/qa-prove-regression.mjs',
  'scripts/lib/regressions/profile-contract.mjs',
  'scripts/lib/regressions/phases.mjs',
  'scripts/lib/regressions/subprocess.mjs',
  'scripts/lib/regressions/results.mjs',
  'scripts/lib/regressions/identity.mjs',
  'scripts/lib/regressions/proof.mjs',
]);
export function proofIdentity(root, profile) {
  const files = [profile.file, profile.definitionFile, ...SHARED_EXECUTION_INPUTS];
  return Object.fromEntries(files.map((file) => [file, sha256(fs.readFileSync(inside(root, file)))]));
}
export function verifyIdentity(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('stale test/fixture or proof identity; rerun the proof');
}

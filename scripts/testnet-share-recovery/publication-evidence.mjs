import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Share the Python reducers' pure contract; never collect network evidence here. */
export function validatePublicationCohort(campaign, admissions, jobs, seals) {
  return JSON.parse(execFileSync('python3', [fileURLToPath(new URL('./publication_evidence.py', import.meta.url))], {
    input: JSON.stringify({ campaign, admissions, jobs, seals }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }));
}
export function requirePublicationCohort(campaign, admissions, jobs, seals) {
  const proof = validatePublicationCohort(campaign, admissions, jobs, seals);
  if (!proof.valid) throw Error(`Publication cohort mismatch: ${proof.errors.join('; ')}`);
  return proof;
}

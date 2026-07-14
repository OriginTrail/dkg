// OT-RFC-61 §3.3/§8 — fleet/policy/scenario loading, validation, S2 credential check.
// CONTRACT FILE: implementors replace TODO bodies; signatures are frozen.

/**
 * Load + validate fleet.json (see fleet.example.json). Throws with a list of
 * problems on invalid shape. Returns {cores, edges, seeds, sshConcurrency,
 * sshConnectTimeoutSec, network, digest} where digest = sha256 of file bytes.
 * Aliases must be unique and match /^core-\d+$/ or /^[a-z][a-z0-9-]*$/.
 * @param {string} path
 */
export function loadFleet(path) { throw new Error('TODO'); }

/**
 * Load + validate policy.json against policy.example.json's shape: every trip in
 * the example MUST be present; values looser than hardMax are clamped-with-error.
 * Returns {trips, quiesce, safetyAbort, permanentData, faucet, digest}.
 * @param {string} path
 */
export function loadPolicy(path) { throw new Error('TODO'); }

/**
 * Load + validate a scenario by name from scenarios/<name>.json and check it is
 * listed in scenarios.json. Scenario trip overrides may only TIGHTEN policy
 * (S3) — validate against the loaded policy. Returns {scenario, digest}.
 * @param {string} name @param {{policy: object, baseDir?: string}} opts
 */
export function loadScenario(name, opts) { throw new Error('TODO'); }

/**
 * S2 credential-isolation check for AUTONOMOUS mode (RFC-61 §8 S2).
 * Verifies, without mutating anything:
 *  1. No ambient SSH agent (SSH_AUTH_SOCK unset or empty agent).
 *  2. The configured sshIdentity exists and is the ONLY credential offered
 *     (BatchMode, IdentitiesOnly=yes).
 *  3. A mutation probe is REFUSED: `ssh <core> -- sudo -n true` must fail AND
 *     an arbitrary command (`echo x`) must NOT round-trip verbatim if a forced
 *     command is configured (forced command returns snapshot output instead).
 * Returns {ok: boolean, checks: Array<{id, pass, evidence}>}. NEVER throws on
 * probe failure — reports. Interactive mode skips this and records mode.
 * @param {object} fleet @param {{mode: 'autonomous'|'interactive'}} opts
 */
export async function verifyCredentialIsolation(fleet, opts) { throw new Error('TODO'); }

/** sha256 hex digest of a file's bytes. @param {string} path */
export function fileDigest(path) { throw new Error('TODO'); }

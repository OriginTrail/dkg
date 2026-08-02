const PRIVATE_LAUNCHER_INPUTS = Object.freeze([
  'DKG_RFC64_M1_CORPUS_FILE',
  'DKG_RFC64_M1_TRUST_ANCHOR_FILE',
  'DKG_RFC64_M1_ARTIFACT',
]);

/** Keep immutable expectations outside the operator adapter's process boundary. */
export function buildSelectiveCoverageAdapterEnvironment(
  parent: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent, NODE_ENV: 'production' };
  for (const name of PRIVATE_LAUNCHER_INPUTS) delete env[name];
  return env;
}

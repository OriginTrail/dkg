import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TypeScriptProgramHost, SemanticRuntimeStore, RUNTIME_DATABASE_FILENAME, startSemanticRuntimeHost, type SemanticRuntimeConfig, type SemanticRuntimeHost } from '@origintrail-official/dkg-semantic-runtime';
import { SemanticProgramConfiguration } from './semantic-runtime-configuration.js';
import { ConfiguredSemanticRuntimeDeps, ConfiguredSemanticRuntimeService } from './semantic-runtime-types.js';
import { validateSemanticRuntimeSettings } from './semantic-runtime-settings.js';

export async function startConfiguredSemanticRuntime(
  config: SemanticRuntimeConfig | undefined,
  deps: ConfiguredSemanticRuntimeDeps,
): Promise<ConfiguredSemanticRuntimeService | null> {
  if (!config || config.enabled === false) return null;
  const previouslyEnabled = config.enabled;
  const fileBindings = config.programBindings;
  const fileRoutes = config.programRoutes;
  if (config.enabled !== true && !deps.activate
    && !(deps.dataDirectory && existsSync(join(deps.dataDirectory, RUNTIME_DATABASE_FILENAME)))) return null;
  // Validate service settings now; the configuration manager validates authority
  // after durable overrides/tombstones have been merged with file defaults.
  validateSemanticRuntimeSettings(config);
  const store = deps.openStore?.()
    ?? (deps.dataDirectory ? SemanticRuntimeStore.openInDataDirectory(deps.dataDirectory) : new SemanticRuntimeStore(':memory:'));
  let host: SemanticRuntimeHost;
  let configuration: SemanticProgramConfiguration;
  try {
    if (config.enabled !== true && !deps.activate && store.programConfigurationRecords().length === 0) { store.close(); return null; }
    configuration = new SemanticProgramConfiguration(store, config);
    config.enabled = true;
    host = await (deps.start ?? startSemanticRuntimeHost)({ config, log: deps.log });
  } catch (error) {
    config.enabled = previouslyEnabled;
    config.programBindings = fileBindings;
    config.programRoutes = fileRoutes;
    store.close();
    throw error;
  }
  deps.log(
    `Semantic runtime ready (watchdog=${config.watchdogMs ?? 100}ms, `
      + 'Wasm execution + durable effect journal enabled)',
  );
  const typescript = new TypeScriptProgramHost();
  const inFlight: ConfiguredSemanticRuntimeService['inFlight'] = new Map();
  return {
    localLlmProvider: deps.localLlmProvider,
    host,
    store,
    configuration,
    typescript,
    inFlight,
    async stop() {
      try {
        await typescript.stop();
        await host.stop();
        await Promise.allSettled([...inFlight.values()].map(invocation => invocation.promise));
      } finally {
        store.close();
      }
    },
  };
}

export type { StoredSemanticProgram } from './semantic-runtime-types.js';
export type { SemanticMemoryLayer } from './semantic-runtime-types.js';
export type { SemanticToolResolution } from './semantic-runtime-types.js';
export type { SemanticProgramResolution } from './semantic-runtime-types.js';
export type { SemanticInvocationResult } from './semantic-runtime-types.js';
export type { SemanticProgramChildInvoker } from './semantic-runtime-types.js';
export type { SemanticProgramForkResult } from './semantic-runtime-types.js';
export { SemanticProgramError } from './semantic-runtime-types.js';
export type { ConfiguredSemanticRuntimeService } from './semantic-runtime-types.js';
export type { ConfiguredSemanticRuntimeDeps } from './semantic-runtime-types.js';
export { loadStoredSemanticProgram } from './semantic-runtime-program-source.js';
export { assertSemanticContextGraphMember } from './semantic-runtime-program-source.js';
export { forkStoredSemanticProgram } from './semantic-runtime-program-source.js';
export { resolveStoredSemanticProgram } from './semantic-runtime-resolution.js';
export { invokeBoundSemanticProgram } from './semantic-runtime-invocation.js';
export { validateBoundSemanticProgram } from './semantic-runtime-resolution.js';
export { invokeStoredSemanticProgram } from './semantic-runtime-invocation.js';
export { loadExecutionOutputs } from './semantic-runtime-execution-persistence.js';
export { buildExecutionQuads } from './semantic-runtime-execution-persistence.js';
export { validateSemanticRuntimeConfig } from './semantic-runtime-settings.js';
export { isSemanticMemoryLayer } from './semantic-runtime-values.js';

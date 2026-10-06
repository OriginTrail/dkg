import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RuntimeAdapterOperation } from '@origintrail-official/dkg-semantic-runtime';

export const LOCAL_LLM_PROGRAM_TOOL = 'urn:dkg:tool:safe-llm';

export interface LocalLlmProgramCapability {
  toolIri: string;
  configurationSha256: string;
  contextGraphId: string;
  ownerAgentAddress: string;
}

export interface LocalLlmProgramProvider {
  capability: LocalLlmProgramCapability;
  run(prompt: string): Promise<unknown>;
}

// The daemon installs its existing read-only, graph-scoped model runtime.
// Program input cannot install a provider or choose an endpoint or credential.
let provider: LocalLlmProgramProvider | undefined;

export function registerLocalLlmProgramProvider(value: LocalLlmProgramProvider): () => void {
  provider = value;
  return () => { if (provider === value) provider = undefined; };
}

export function localLlmConfigurationSha256(settings: {
  llamaUrl: string; model: string; defaultProjectId?: string;
  domainProfile?: unknown; adapterPaths?: string[];
}, ownerAgentAddress: string): string {
  const adapters = (settings.adapterPaths ?? []).map(path => ({
    path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }));
  return createHash('sha256').update(JSON.stringify({
    endpoint: settings.llamaUrl, model: settings.model,
    contextGraphId: settings.defaultProjectId, ownerAgentAddress: ownerAgentAddress.toLowerCase(),
    domainProfile: settings.domainProfile, adapters,
    allowWrite: false, strictProjectScope: true,
  })).digest('hex');
}

/** Reuse llm/safe's component boundary and the native chat runtime. */
export function createLocalLlmProgramAdapter(
  contextGraphId: string,
  executorAddress: string,
  grant: { toolIri: string; configurationSha256: string },
  assertAuthorized: () => Promise<void>,
): RuntimeAdapterOperation<{ prompt: string }, string> {
  const installed = provider;
  const matches = () => Boolean(installed && provider === installed
    && grant.toolIri === LOCAL_LLM_PROGRAM_TOOL
    && installed.capability.configurationSha256 === grant.configurationSha256
    && installed.capability.contextGraphId === contextGraphId
    && installed.capability.ownerAgentAddress.toLowerCase() === executorAddress.toLowerCase());
  return {
    id: 'llm/safe', version: '1',
    witInterface: 'origintrail:semantic-runtime/safe-llm@0.1.0',
    implementationVersion: 'local-llm-program-v1',
    implementationHash: createHash('sha256').update(readFileSync(new URL(import.meta.url)))
      .update(grant.configurationSha256).digest('hex'),
    enabled: matches,
    effectClass: 'model-invocation', verb: 'run', idempotencyClass: 'non_repeatable',
    reconciliationRule: 'manual-review-after-model-or-child-dispatch',
    validateInput(value) {
      const prompt = (value as { prompt?: unknown })?.prompt;
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) {
        throw new Error('INVALID_SAFE_LLM_ARGUMENT');
      }
      return { prompt };
    },
    async dispatch(_authorization, input) {
      await assertAuthorized();
      if (!matches()) throw new Error('LOCAL_LLM_PROGRAM_CONFIGURATION_CHANGED');
      const result = await installed!.run(input.prompt);
      await assertAuthorized();
      if (!matches()) throw new Error('LOCAL_LLM_PROGRAM_CONFIGURATION_CHANGED');
      const output = JSON.stringify(result);
      return {
        status: 'succeeded', output: JSON.stringify({ output, childExecutions: [] }),
        evidenceRef: 'urn:sr:adapter-output:' + createHash('sha256').update(output).digest('hex'),
      };
    },
    reconcile: async () => ({ status: 'unknown', evidenceRef: 'urn:sr:reconciliation:manual-review-required' }),
    couldHaveReachedTarget: error => !(error instanceof Error
      && ['INVALID_SAFE_LLM_ARGUMENT', 'LOCAL_LLM_PROGRAM_CONFIGURATION_CHANGED'].includes(error.message)),
  };
}

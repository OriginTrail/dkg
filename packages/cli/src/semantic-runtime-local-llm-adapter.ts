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
  readonly capability: LocalLlmProgramCapability;
  isEnabled(): boolean;
  run(prompt: string): Promise<unknown>;
}

export function localLlmAdapterHashes(paths: readonly string[] = []) {
  return paths.map(path => ({
    path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }));
}

export function localLlmConfigurationSha256(settings: {
  llamaUrl: string; model: string; defaultProjectId?: string;
  domainProfile?: unknown; adapterPaths?: string[];
}, ownerAgentAddress: string): string {
  const adapters = localLlmAdapterHashes(settings.adapterPaths);
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
  provider: LocalLlmProgramProvider | undefined,
): RuntimeAdapterOperation<{ prompt: string }, string> {
  const installed = provider;
  const matches = () => Boolean(installed && installed.isEnabled()
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
      if (!matches()) throw new Error('LOCAL_LLM_PROGRAM_CONFIGURATION_CHANGED_BEFORE_DISPATCH');
      const result = await installed!.run(input.prompt);
      await assertAuthorized();
      if (!matches()) throw new Error('LOCAL_LLM_PROGRAM_CONFIGURATION_CHANGED_AFTER_DISPATCH');
      const output = JSON.stringify(result);
      return {
        status: 'succeeded', output: JSON.stringify({ output, childExecutions: [] }),
        evidenceRef: 'urn:sr:adapter-output:' + createHash('sha256').update(output).digest('hex'),
      };
    },
    reconcile: async () => ({ status: 'unknown', evidenceRef: 'urn:sr:reconciliation:manual-review-required' }),
    couldHaveReachedTarget: error => !(error instanceof Error
      && ['INVALID_SAFE_LLM_ARGUMENT', 'LOCAL_LLM_PROGRAM_CONFIGURATION_CHANGED_BEFORE_DISPATCH'].includes(error.message)),
  };
}

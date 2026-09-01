import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LlmClient, type LlmConfig } from '@origintrail-official/dkg-node-ui';
import type { RuntimeAdapterOperation } from '@origintrail-official/dkg-semantic-runtime';

export interface InvestigatorInput {
  prompt: string;
}

export function createInvestigatorAdapter(
  llmConfig?: LlmConfig,
): RuntimeAdapterOperation<InvestigatorInput, string> {
  const implementationHash = createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex');
  const useCodex = process.env.SEMANTIC_RUNTIME_LLM_PROVIDER === 'codex';
  return {
    id: 'agent/investigate',
    version: '1',
    witInterface: 'origintrail:semantic-tools/investigator@1',
    implementationVersion: '1',
    implementationHash,
    enabled: () => useCodex || Boolean(llmConfig?.apiKey),
    effectClass: 'model-invocation',
    verb: 'investigate',
    idempotencyClass: 'non_repeatable',
    reconciliationRule: 'manual-review-on-ambiguous-codex-dispatch',
    validateInput(value): InvestigatorInput {
      if (
        typeof value !== 'object'
        || value === null
        || !('prompt' in value)
        || typeof value.prompt !== 'string'
      ) throw new Error('INVALID_LLM_ARGUMENT');
      return { prompt: value.prompt };
    },
    async dispatch(authorization, input) {
      if (!useCodex && !llmConfig?.apiKey) throw new Error('LLM_NOT_CONFIGURED');
      traceTiming('start', authorization.effectId);
      try {
        const output = useCodex
          ? await completeWithCodex(input.prompt)
          : (await new LlmClient().complete({
            config: llmConfig!,
            request: {
              messages: [{ role: 'user', content: input.prompt }],
              temperature: 0,
              maxTokens: 512,
              stream: false,
            },
          })).message.content ?? '';
        return {
          status: 'succeeded',
          output,
          evidenceRef: `urn:sr:adapter-output:${createHash('sha256').update(output, 'utf8').digest('hex')}`,
        };
      } finally {
        traceTiming('finish', authorization.effectId);
      }
    },
    reconcile: async () => ({
      status: 'unknown',
      evidenceRef: 'urn:sr:reconciliation:manual-review-required',
    }),
    couldHaveReachedTarget: (error) => !(
      error instanceof Error
      && (error.message === 'LLM_NOT_CONFIGURED' || error.message === 'INVALID_LLM_ARGUMENT')
    ),
  };
}

function traceTiming(phase: 'start' | 'finish', effectId: string): void {
  if (process.env.SEMANTIC_RUNTIME_TRACE_ADAPTER_TIMING !== '1') return;
  console.info(`semantic-runtime-tool-timing ${JSON.stringify({
    operation: 'agent/investigate',
    phase,
    effectId,
    monotonicNs: process.hrtime.bigint().toString(),
  })}`);
}

function completeWithCodex(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.SEMANTIC_RUNTIME_CODEX_BIN ?? 'codex', [
      'exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-user-config',
      '--ignore-rules', '--color', 'never', prompt,
    ], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
    child.stdin?.end();
  });
}

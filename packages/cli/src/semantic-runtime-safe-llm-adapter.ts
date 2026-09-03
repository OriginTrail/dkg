import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { LlmConfig } from '@origintrail-official/dkg-node-ui';
import type { RuntimeAdapterOperation } from '@origintrail-official/dkg-semantic-runtime';

export interface SafeLlmProgram {
  capabilityId: string;
  programIri: string;
  name: string;
  description: string;
}

export interface SafeLlmChildResult {
  executionIri: string;
  executionUal?: string;
  outputs?: string[];
  persisted: true;
}

export type SafeLlmChildInvoker = (
  programIri: string,
  invocationId: string,
) => Promise<SafeLlmChildResult>;

interface RunnerMessage {
  type?: unknown;
  id?: unknown;
  capabilityId?: unknown;
  output?: unknown;
  message?: unknown;
}

interface SafeLlmProviderConfig {
  apiKey?: string;
  model: string;
  baseURL: string;
}

const MAX_RUNNER_LINE_BYTES = 1_048_576;
const MAX_TOOL_CALLS = 4;
const RUNNER_TIMEOUT_MS = 10 * 60_000;

export function createSafeLlmAdapter(
  llmConfig: LlmConfig | undefined,
  programs: SafeLlmProgram[],
  invokeChild?: SafeLlmChildInvoker,
): RuntimeAdapterOperation<{ prompt: string }, string> {
  const provider = resolveSafeLlmProvider(llmConfig);
  const runnerBinary = process.env.SEMANTIC_RUNTIME_RIG_BIN
    ?? fileURLToPath(new URL('../../../rust/target/release/dkg-safe-llm-runner', import.meta.url));
  const implementationHash = createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .update(existsSync(runnerBinary) ? readFileSync(runnerBinary) : 'runner-missing')
    .digest('hex');
  return {
    id: 'llm/safe',
    version: '1',
    witInterface: 'origintrail:semantic-runtime/safe-llm@0.1.0',
    implementationVersion: '1',
    implementationHash,
    enabled: () => Boolean(
      provider
      && programs.length > 0
      && programs.length <= 32
      && existsSync(runnerBinary),
    ),
    effectClass: 'model-invocation',
    verb: 'run',
    idempotencyClass: 'non_repeatable',
    reconciliationRule: 'manual-review-after-model-or-child-dispatch',
    validateInput(value) {
      if (
        typeof value !== 'object'
        || value === null
        || !('prompt' in value)
        || typeof value.prompt !== 'string'
        || Buffer.byteLength(value.prompt, 'utf8') === 0
        || Buffer.byteLength(value.prompt, 'utf8') > 65_536
      ) throw new Error('INVALID_SAFE_LLM_ARGUMENT');
      return { prompt: value.prompt };
    },
    async dispatch(authorization, input) {
      if (!provider || programs.length === 0 || !invokeChild || !existsSync(runnerBinary)) {
        throw new Error('SAFE_LLM_NOT_CONFIGURED');
      }
      const result = await runRig(
        provider,
        input.prompt,
        programs,
        invokeChild,
        authorization.effectId,
        runnerBinary,
      );
      return {
        status: 'succeeded',
        output: JSON.stringify(result),
        evidenceRef: `urn:sr:adapter-output:${createHash('sha256').update(result.output, 'utf8').digest('hex')}`,
      };
    },
    reconcile: async () => ({
      status: 'unknown',
      evidenceRef: 'urn:sr:reconciliation:manual-review-required',
    }),
    couldHaveReachedTarget: (error) => !(
      error instanceof Error
      && ['SAFE_LLM_NOT_CONFIGURED', 'INVALID_SAFE_LLM_ARGUMENT'].includes(error.message)
    ),
  };
}

async function runRig(
  provider: SafeLlmProviderConfig,
  prompt: string,
  programs: SafeLlmProgram[],
  invokeChild: SafeLlmChildInvoker,
  effectId: string,
  binary: string,
): Promise<{ output: string; childExecutions: string[] }> {
  const child = spawn(binary, [], {
    env: provider.apiKey ? { OPENAI_API_KEY: provider.apiKey } : {},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let spawnError: Error | undefined;
  let timedOut = false;
  let stderr = '';
  child.once('error', (error) => { spawnError = error; });
  child.stdin.on('error', (error) => { spawnError ??= error; });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, RUNNER_TIMEOUT_MS);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < MAX_RUNNER_LINE_BYTES) stderr += chunk;
  });
  child.stdin.write(`${JSON.stringify({
    prompt,
    model: provider.model,
    baseUrl: provider.baseURL,
    maxTurns: 4,
    maxTokens: 512,
    tools: programs.map(({ capabilityId, name, description }) => ({
      capabilityId,
      name,
      description,
    })),
  })}\n`);

  const byCapability = new Map(programs.map((program) => [program.capabilityId, program]));
  const childExecutions: string[] = [];
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let calls = 0;
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line, 'utf8') > MAX_RUNNER_LINE_BYTES) {
        throw new Error('SAFE_LLM_RUNNER_MESSAGE_TOO_LARGE');
      }
      let message: RunnerMessage;
      try {
        message = JSON.parse(line) as RunnerMessage;
      } catch {
        throw new Error('SAFE_LLM_RUNNER_PROTOCOL_INVALID');
      }
      if (message.type === 'complete' && typeof message.output === 'string') {
        return { output: message.output, childExecutions };
      }
      if (message.type === 'error' && typeof message.message === 'string') {
        throw new Error(`SAFE_LLM_RUNNER_FAILED:${message.message}`);
      }
      if (
        message.type !== 'call'
        || typeof message.id !== 'number'
        || !Number.isSafeInteger(message.id)
        || typeof message.capabilityId !== 'string'
      ) throw new Error('SAFE_LLM_RUNNER_PROTOCOL_INVALID');
      calls += 1;
      const program = byCapability.get(message.capabilityId);
      if (calls > MAX_TOOL_CALLS || !program) {
        child.stdin.write(`${JSON.stringify({
          type: 'result', id: message.id, ok: false, error: 'program capability denied',
        })}\n`);
        continue;
      }
      try {
        const result = await invokeChild(
          program.programIri,
          invocationUuid(effectId, calls, program.capabilityId),
        );
        if (result.persisted !== true || !Array.isArray(result.outputs)) {
          throw new Error('child Execution output was not persisted');
        }
        childExecutions.push(result.executionIri);
        child.stdin.write(`${JSON.stringify({
          type: 'result',
          id: message.id,
          ok: true,
          output: JSON.stringify({
            executionIri: result.executionIri,
            ...(result.executionUal ? { executionUal: result.executionUal } : {}),
            outputs: result.outputs,
          }),
        })}\n`);
      } catch (error) {
        child.stdin.write(`${JSON.stringify({
          type: 'result', id: message.id, ok: false, error: safeMessage(error),
        })}\n`);
      }
    }
    throw spawnError ?? new Error(timedOut
      ? 'SAFE_LLM_RUNNER_TIMEOUT'
      : `SAFE_LLM_RUNNER_EXITED:${stderr.trim() || child.exitCode}`);
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}

function resolveSafeLlmProvider(llmConfig: LlmConfig | undefined): SafeLlmProviderConfig | undefined {
  const localEndpoint = process.env.DKG_LLM_URL?.trim() || process.env.LLAMA_URL?.trim();
  const configuredBaseURL = llmConfig?.baseURL?.trim();
  const baseURL = normalizeOpenAiBaseURL(configuredBaseURL || localEndpoint
    || (llmConfig?.apiKey ? 'https://api.openai.com/v1' : undefined));
  if (!baseURL) return undefined;

  const loopback = isLoopback(baseURL);
  const apiKey = (configuredBaseURL
    ? llmConfig?.apiKey
    : localEndpoint
      ? process.env.DKG_LLM_API_KEY
      : llmConfig?.apiKey)?.trim() || undefined;
  if (!loopback && !apiKey) return undefined;

  return {
    apiKey,
    baseURL,
    model: llmConfig?.model?.trim()
      || process.env.DKG_LLM_MODEL?.trim()
      || process.env.LLAMA_MODEL?.trim()
      || (loopback ? 'local-model' : 'gpt-5-mini'),
  };
}

function normalizeOpenAiBaseURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function isLoopback(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function invocationUuid(effectId: string, call: number, capabilityId: string): string {
  const bytes = createHash('sha256')
    .update(`dkg.safe-llm.v1\0${effectId}\0${call}\0${capabilityId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

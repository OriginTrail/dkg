/**
 * The `chat-connector` executor (spec §5.6): one authorized `openai-chat/v1`
 * serve → upstream connector call → metered `openai-chat-result/v1` bytes.
 *
 * Pinned basis: units are counted with the offering's pinned engine under the
 * `openai-chat-count/v1` template, and the completion is bounded with
 * `boundCompletion` so `servedUnits ≤ maxUnits` holds BY CONSTRUCTION (an
 * upstream that ignores `max_tokens` is truncated, not over-billed).
 * Provider-reported basis (openai-compatible without a pin): `servedUnits` is
 * the upstream usage, and a total above `maxUnits` fails closed
 * `METERING_OVERRUN` (a seller fault — the buyer sized from a strict bound).
 *
 * Every failure is a refusal BEFORE any receipt exists: the authorization
 * stays burned (fail closed), the buyer is charged nothing, and the seller
 * absorbs any upstream cost.
 */
import {
  CHAT_PAYLOAD_SCHEMA,
  CHAT_RESULT_SCHEMA,
  CHAT_TEMPLATE_OPENAI_COUNT_V1,
  CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST,
  MAX_SERVE_RESULT_BYTES,
  boundCompletion,
  countChatPromptUnits,
  countChatToolUnits,
  normalizeToolCalls,
  parseChatServePayload,
  validateToolCallsAgainstOptions,
  type ChatFinishReason,
  type ChatMeteringBlock,
  type ChatServeResult,
  type ChatToolCall,
  type TokenCountEngine,
} from '@origintrail-official/dkg-marketplace';
import type { ChatConnector } from './connectors/types.js';
import {
  MarketplaceExecutionError,
  parseJsonPayload,
  type MarketplaceExecution,
  type MarketplaceExecutor,
} from './executors.js';

export interface ChatConnectorExecutorOptions {
  connector: ChatConnector;
  /** Canonical model id of the offering (payload `model` must equal it). */
  modelId: string;
  /** The pinned engine; absent → provider-reported basis. */
  engine?: TokenCountEngine;
  contextLength?: bigint;
  /** Result-size cap checked before signing; default `MAX_SERVE_RESULT_BYTES`. */
  maxResultBytes?: number;
}

const textEncoder = new TextEncoder();
const minBig = (...values: bigint[]): bigint => values.reduce((a, b) => (b < a ? b : a));

function refuse(code: ConstructorParameters<typeof MarketplaceExecutionError>[0], message: string): never {
  throw new MarketplaceExecutionError(code, message);
}

export function createChatConnectorExecutor(opts: ChatConnectorExecutorOptions): MarketplaceExecutor {
  const { connector, modelId, engine, contextLength } = opts;
  const maxResultBytes = opts.maxResultBytes ?? MAX_SERVE_RESULT_BYTES;
  const transport = connector.description.toolTransport;

  return {
    kind: 'inference',
    async execute(payloadBytes, bounds): Promise<MarketplaceExecution> {
      const { maxUnits } = bounds;
      // 1. Payload shape + model binding.
      const parsed = parseChatServePayload(parseJsonPayload(payloadBytes));
      if (!parsed.ok) refuse('BAD_PAYLOAD', `chat payload (${CHAT_PAYLOAD_SCHEMA}) rejected: ${parsed.detail}`);
      const { payload, options } = parsed;
      if (payload.model !== modelId) refuse('MODEL_MISMATCH', `payload model ${payload.model}, offering serves ${modelId}`);

      // 2. Tool fields need a native transport.
      const carriesTools = options.tools !== undefined || options.toolChoice !== undefined
        || options.parallelToolCalls !== undefined
        || payload.messages.some((m) => Boolean(m.tool_calls?.length) || m.tool_call_id !== undefined);
      if (carriesTools && transport !== 'native') {
        refuse('TOOLS_UNSUPPORTED', `this offering's tool transport is ${transport}; tool fields need native`);
      }

      // 3. Budget.
      let promptUnits = 0n;
      let toolUnits = 0n;
      let budget = BigInt(payload.max_tokens);
      if (engine) {
        promptUnits = countChatPromptUnits(engine, payload.messages);
        toolUnits = countChatToolUnits(engine, payload.messages, options);
      }
      const fixed = promptUnits + toolUnits;
      if (engine) {
        if (fixed >= maxUnits) refuse('OVER_MAX_UNITS', `prompt meters ${fixed} units, at or over maxUnits ${maxUnits}`);
        if (contextLength !== undefined && fixed + 1n > contextLength) {
          refuse('CONTEXT_EXCEEDED', `prompt meters ${fixed} units; the context holds ${contextLength}`);
        }
        budget = minBig(budget, maxUnits - fixed, ...(contextLength !== undefined ? [contextLength - fixed] : []));
      }

      // 4. Upstream.
      const outcome = await connector.complete({
        upstreamModel: connector.description.upstreamModel,
        messages: payload.messages,
        maxTokens: Number(budget),
        ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
        ...(payload.top_p !== undefined ? { topP: payload.top_p } : {}),
        ...(payload.seed !== undefined ? { seed: payload.seed } : {}),
        ...(payload.stop !== undefined ? { stop: payload.stop } : {}),
        ...(transport === 'native' && options.tools ? { tools: options.tools } : {}),
        ...(transport === 'native' && options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
        ...(transport === 'native' && options.parallelToolCalls !== undefined
          ? { parallelToolCalls: options.parallelToolCalls }
          : {}),
      });
      if (!outcome.ok) refuse(outcome.code, `upstream ${outcome.code} (status ${outcome.status}): ${outcome.detail}`);

      // 5. A provider must never name a tool the caller did not expose.
      let toolCalls: ChatToolCall[] | undefined;
      if (outcome.toolCalls?.length) {
        const normalized = normalizeToolCalls(outcome.toolCalls, 'upstream tool_calls');
        if (!normalized.ok) refuse('UPSTREAM_ERROR', normalized.detail);
        toolCalls = normalized.value;
      }
      const policy = validateToolCallsAgainstOptions(toolCalls, options, 'upstream tool_calls');
      if (!policy.ok) refuse('UPSTREAM_ERROR', policy.detail);

      // 6. Meter.
      let metering: ChatMeteringBlock;
      let content = outcome.content;
      let truncated = false;
      const provider = outcome.providerUsage;
      if (engine) {
        const toolCallUnits = toolCalls ? BigInt(engine.encodeCount(JSON.stringify(toolCalls))) : 0n;
        if (fixed + toolCallUnits > maxUnits) {
          refuse('OVER_MAX_UNITS', `tool calls meter ${toolCallUnits} units past maxUnits ${maxUnits} (tool calls cannot be truncated)`);
        }
        const cap = minBig(budget, maxUnits - fixed) - toolCallUnits;
        const bounded = boundCompletion(engine, content, cap < 0n ? 0n : cap);
        content = bounded.text;
        truncated = bounded.truncated;
        const completionUnits = BigInt(engine.encodeCount(content)) + toolCallUnits;
        metering = {
          basis: 'pinned',
          tokenizer: { kind: engine.kind, digest: engine.digest },
          chatTemplate: { id: CHAT_TEMPLATE_OPENAI_COUNT_V1.version, digest: CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST },
          promptUnits: Number(promptUnits),
          toolUnits: Number(toolUnits),
          completionUnits: Number(completionUnits),
          servedUnits: Number(fixed + completionUnits),
          truncated,
          ...(provider ? { providerUsage: { prompt_tokens: provider.promptTokens, completion_tokens: provider.completionTokens } } : {}),
        };
      } else {
        if (!provider) refuse('UPSTREAM_ERROR', 'provider-reported metering needs upstream usage, and the reply carried none');
        const served = BigInt(provider.promptTokens) + BigInt(provider.completionTokens);
        if (served > maxUnits) {
          refuse('METERING_OVERRUN', `upstream usage ${served} exceeds the authorized maxUnits ${maxUnits}`);
        }
        metering = {
          basis: 'provider-reported',
          promptUnits: provider.promptTokens,
          toolUnits: 0,
          completionUnits: provider.completionTokens,
          servedUnits: Number(served),
          truncated: false,
          providerUsage: { prompt_tokens: provider.promptTokens, completion_tokens: provider.completionTokens },
        };
      }

      // 7. finish_reason, normalized.
      const finishReason: ChatFinishReason = toolCalls
        ? 'tool_calls'
        : truncated || outcome.finishReason === 'length' ? 'length' : 'stop';

      // 8. Emit (compact JSON); refuse an undeliverable size before any receipt.
      const result: ChatServeResult = {
        schema: CHAT_RESULT_SCHEMA,
        model: modelId,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: toolCalls && content === '' ? null : content,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        }],
        usage: metering.basis === 'pinned'
          ? {
              prompt_tokens: metering.promptUnits + metering.toolUnits,
              completion_tokens: metering.completionUnits,
              total_tokens: metering.servedUnits,
            }
          : {
              prompt_tokens: metering.providerUsage!.prompt_tokens,
              completion_tokens: metering.providerUsage!.completion_tokens,
              total_tokens: metering.servedUnits,
            },
        metering,
      };
      const resultBytes = textEncoder.encode(JSON.stringify(result));
      if (resultBytes.byteLength > maxResultBytes) {
        refuse('UPSTREAM_ERROR', `result is ${resultBytes.byteLength} bytes, over the ${maxResultBytes}-byte deliverable cap`);
      }
      return { resultBytes, unitsServed: BigInt(metering.servedUnits) };
    },
  };
}

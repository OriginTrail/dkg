// The devnet offering sets of the OT-RFC-27 marketplace console, in one
// place: the seeder publishes them, the console's "Load devnet defaults"
// offers them, and the e2e suite's gateway arc republishes the chat offering
// against its own in-process llm-stub. Every field that reaches the offer KA
// (ask, modelId, tokenizer pin, upstream model, display name, context
// length) is identical across those callers, so a re-publish of the same set
// is "unchanged" (no transaction). Base URLs and secret-file paths are
// seller-local connector config and are never published.
//
// Secrets: the openai-compatible connector reads its bearer key from a
// `KEY=value` file at call time. The devnet stub key lives in
// `.devnet/node<n>/marketplace/.secrets/llm-stub.env` (file 0600, dir 0700).

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nodeHome } from './lib.mjs';

/** The key the devnet llm-stub pins (`LLM_STUB_API_KEY`) and the sellers send. */
export const LLM_STUB_API_KEY = 'devnet-stub-key';
export const LLM_STUB_DEFAULT_PORT = 18080;
/** The chat model the devnet sellers offer (canonical modelId). */
export const STUB_MODEL_ID = 'stub-chat';
export const STUB_TOKENIZER_KIND = 'stub-words-v1';
/** The one command that starts the standalone stub the seeded offerings point at. */
export const LLM_STUB_RUN_HINT = `LLM_STUB_API_KEY=${LLM_STUB_API_KEY} pnpm devnet:marketplace:llm-stub`;

export const ASK_LLM_A = '500000000000'; // 0.5 µTRAC/token
export const ASK_KNOWLEDGE_A = '15000000000000'; // 15 µTRAC/query-unit
export const ASK_LLM_B = '800000000000'; // 0.8 µTRAC/token
export const ASK_CHAT_A = '500000000000'; // 0.5 µTRAC/token
export const ASK_CHAT_B = '800000000000'; // 0.8 µTRAC/token

/** LLM_STUB_PORT when it is a valid port, else 18080 (the stub's own rule). */
export function llmStubPort(env = process.env) {
  const port = Number(env.LLM_STUB_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : LLM_STUB_DEFAULT_PORT;
}

/** Absolute path of node `num`'s stub secret file. */
export function stubSecretFile(num) {
  return join(nodeHome(num), 'marketplace', '.secrets', 'llm-stub.env');
}

/**
 * Write node `num`'s stub secret file: `.secrets/` 0700, the file 0600.
 * `writeFileSync`'s mode applies only on create, so both are chmodded after.
 * Returns the absolute path.
 */
export function writeStubSecret(num, key = LLM_STUB_API_KEY) {
  const file = stubSecretFile(num);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(file, `# devnet llm-stub bearer (written by the marketplace console seeder)\nOPENAI_API_KEY=${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/**
 * The `devnet-chat` offering: an openai-compatible chat connector pointed at
 * the llm-stub, metered with the pinned `stub-words-v1` engine.
 */
export function chatOffering({ askPerUnitWei, secretEnvFile, port = llmStubPort() }) {
  return {
    offeringLocalId: 'devnet-chat',
    serviceType: 'inference',
    unit: 'token',
    modelId: STUB_MODEL_ID,
    askPerUnitWei: String(askPerUnitWei),
    executor: 'chat-connector',
    connector: {
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      upstreamModel: STUB_MODEL_ID,
      secretEnvFile,
      toolTransport: 'native',
      maxTokensField: 'max_tokens',
      timeoutMs: 120_000,
    },
    metering: { tokenizer: { kind: STUB_TOKENIZER_KIND } },
    model: { displayName: 'Stub Chat', contextLength: '32768' },
  };
}

/** Seller A (node1) and seller B (node3) offering sets, keyed by node number. */
export function devnetOfferings({ port = llmStubPort() } = {}) {
  return {
    1: [
      { offeringLocalId: 'devnet-llm', serviceType: 'inference', unit: 'token', askPerUnitWei: ASK_LLM_A },
      { offeringLocalId: 'devnet-knowledge', serviceType: 'query', unit: 'query-unit', askPerUnitWei: ASK_KNOWLEDGE_A },
      chatOffering({ askPerUnitWei: ASK_CHAT_A, secretEnvFile: stubSecretFile(1), port }),
    ],
    3: [
      { offeringLocalId: 'devnet-llm', serviceType: 'inference', unit: 'token', askPerUnitWei: ASK_LLM_B },
      chatOffering({ askPerUnitWei: ASK_CHAT_B, secretEnvFile: stubSecretFile(3), port }),
    ],
  };
}

/** GET <stub>/healthz → { ok, model, calls } | { ok: false, error }. Never throws. */
export async function probeLlmStub(port = llmStubPort(), timeoutMs = 2_000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    return { ok: json?.ok === true, model: json?.model, calls: json?.calls };
  } catch (err) {
    return { ok: false, error: err?.cause?.code ?? err?.name ?? String(err) };
  }
}

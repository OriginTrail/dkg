/**
 * Connector "llamacpp" — weights-pinned local serving through a loopback
 * llama.cpp server. Port of the fork's `connector-llamacpp.ts`: the GGUF is
 * hashed at mount (streamed; cached by `{path, size, mtimeMs}` so a restart
 * does not rehash gigabytes) and published as `mkt:weightsDigest`, and the
 * serving settings are pinned and published verbatim — request `temperature`,
 * `top_p` and `seed` are ignored. The fork's `/apply-template` + `/tokenize`
 * evidence is dropped: metering uses the pinned `hf-bpe-v1` engine over the
 * committed bytes. Tools travel by the prompt transport only. The server's
 * own model id (often a file path) is used upstream only, never published.
 */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { writeFileAtomic0600 } from '../atomic-file.js';
import type { MarketplaceConnectorConfig } from '../config.js';
import {
  classifyStatus,
  classifyTransportError,
  failure,
  parseUpstreamBaseUrl,
  readCappedText,
  resolveTimeoutMs,
  upstreamFetch,
} from './http.js';
import { parseOpenAiChatReply } from './openai-compatible.js';
import type { ChatConnector, ConnectorChatOutcome, ConnectorChatRequest } from './types.js';
import { MarketplaceConnectorMountError } from './types.js';

type LlamaCppConfig = Extract<MarketplaceConnectorConfig, { kind: 'llamacpp' }>;

const DEFAULT_TIMEOUT_MS = 120_000;
/** A 5 s probe aborted spuriously while a concurrent mount hashed a 9 GB GGUF (fork lesson). */
const MOUNT_PROBE_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 10_000;
const DIGEST_CACHE_FILE = 'connector-digests.json';
const DECIMAL_STRING = /^(0|[1-9]\d*)(\.\d+)?$/;
const CONTEXT_OVERFLOW =
  /request\s*\((\d+)\s+tokens?\)\s+exceeds\s+the\s+available\s+context\s+size\s*\((\d+)\s+tokens?\)/i;

/** Stream a file through sha256 → `sha256:<hex>`. */
export async function sha256FileDigest(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(`sha256:${hash.digest('hex')}`))
      .on('error', reject);
  });
}

type DigestCache = Record<string, string>;

function readDigestCache(file: string): DigestCache {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as DigestCache) : {};
  } catch {
    return {};
  }
}

/** GGUF digest, cached in `<dataDir>/marketplace/connector-digests.json` keyed by `{path,size,mtimeMs}`. */
async function ggufDigest(
  ggufPath: string,
  deps: { dataDir?: string; hashFile?: (path: string) => Promise<string> },
): Promise<string> {
  const stat = statSync(ggufPath);
  const key = JSON.stringify({ path: ggufPath, size: stat.size, mtimeMs: stat.mtimeMs });
  const cacheFile = deps.dataDir ? join(deps.dataDir, 'marketplace', DIGEST_CACHE_FILE) : undefined;
  const cache = cacheFile ? readDigestCache(cacheFile) : {};
  const cached = cache[key];
  if (typeof cached === 'string' && /^sha256:[0-9a-f]{64}$/.test(cached)) return cached;
  const digest = await (deps.hashFile ?? sha256FileDigest)(ggufPath);
  if (cacheFile) {
    // Drop stale entries for the same path (a replaced file must not pin twice).
    const next: DigestCache = {};
    for (const [entryKey, value] of Object.entries(cache)) {
      try {
        if ((JSON.parse(entryKey) as { path?: unknown }).path !== ggufPath) next[entryKey] = value;
      } catch { /* malformed key — dropped */ }
    }
    next[key] = digest;
    try {
      writeFileAtomic0600(cacheFile, `${JSON.stringify(next, null, 2)}\n`);
    } catch { /* cache is an optimization only */ }
  }
  return digest;
}

/** llama.cpp's context overflow → `CONTEXT_EXCEEDED`; any other non-2xx by status. */
export function classifyLlamaCppFailure(status: number, body: string): ConnectorChatOutcome {
  const overflow = CONTEXT_OVERFLOW.exec(body);
  if (overflow) {
    return failure('CONTEXT_EXCEEDED', status, `request requires ${overflow[1]} tokens but the context holds ${overflow[2]}`);
  }
  return failure(classifyStatus(status), status, `llama.cpp returned HTTP ${status}`);
}

export async function mountLlamaCppConnector(
  config: LlamaCppConfig,
  deps: { dataDir?: string; fetch?: typeof fetch; now?: () => number; hashFile?: (path: string) => Promise<string> },
): Promise<ChatConnector> {
  const label = 'connector(llamacpp)';
  const { base, origin } = parseUpstreamBaseUrl(config.baseUrl, 'loopback-http', label);
  if (typeof config.ggufPath !== 'string' || !isAbsolute(config.ggufPath)) {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.ggufPath must be an absolute path`);
  }
  const settings = config.settings as Partial<LlamaCppConfig['settings']> | undefined;
  if (
    !settings
    || typeof settings.seed !== 'number' || !Number.isSafeInteger(settings.seed)
    || typeof settings.temperature !== 'string' || !DECIMAL_STRING.test(settings.temperature)
    || typeof settings.ctx !== 'number' || !Number.isSafeInteger(settings.ctx) || settings.ctx <= 0
  ) {
    throw new MarketplaceConnectorMountError(
      'CONNECTOR_CONFIG',
      `${label}.settings must be { seed: integer, temperature: decimal string, ctx: positive integer }`,
    );
  }
  const pinned = { seed: settings.seed, temperature: settings.temperature, ctx: settings.ctx };
  try {
    if (!statSync(config.ggufPath).isFile()) throw new Error('not a file');
  } catch {
    throw new MarketplaceConnectorMountError('CONNECTOR_GGUF_ABSENT', `${label}.ggufPath ${config.ggufPath} does not exist`);
  }
  const timeoutMs = resolveTimeoutMs(config.timeoutMs, DEFAULT_TIMEOUT_MS, label);
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  let serverModelId: string;
  try {
    const res = await upstreamFetch(fetchImpl, `${base}/v1/models`, { method: 'GET', timeoutMs: MOUNT_PROBE_TIMEOUT_MS });
    const text = await readCappedText(res);
    if (res.status !== 200) throw new Error(`/v1/models answered HTTP ${res.status}`);
    const id = (JSON.parse(text) as { data?: Array<{ id?: unknown }> }).data?.[0]?.id;
    serverModelId = typeof id === 'string' && id.length > 0 ? id : 'default';
  } catch (error) {
    const detail = error instanceof Error && error.message.startsWith('/v1/models')
      ? error.message
      : classifyTransportError(error).detail;
    throw new MarketplaceConnectorMountError('CONNECTOR_UNHEALTHY', `${label} at ${origin} is not healthy: ${detail}`);
  }
  let weightsDigest: string;
  try {
    weightsDigest = await ggufDigest(config.ggufPath, deps);
  } catch {
    throw new MarketplaceConnectorMountError('CONNECTOR_GGUF_ABSENT', `${label}.ggufPath ${config.ggufPath} could not be hashed`);
  }

  return {
    description: {
      kind: 'llamacpp',
      toolTransport: 'prompt',
      provenanceClass: 'weights-pinned',
      upstreamModel: serverModelId,
      upstreamOrigin: origin,
      contextLength: BigInt(pinned.ctx),
      weightsDigest,
      servingSeed: BigInt(pinned.seed),
      servingTemperature: pinned.temperature,
      secretConfigured: false,
    },

    async complete(request: ConnectorChatRequest): Promise<ConnectorChatOutcome> {
      const body = {
        model: serverModelId,
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        max_tokens: request.maxTokens,
        temperature: Number(pinned.temperature),
        seed: pinned.seed,
        ...(request.stop !== undefined ? { stop: request.stop } : {}),
        stream: false,
      };
      let text: string;
      let status: number;
      try {
        const res = await upstreamFetch(fetchImpl, `${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          timeoutMs,
        });
        status = res.status;
        text = await readCappedText(res);
      } catch (error) {
        return classifyTransportError(error);
      }
      if (status < 200 || status >= 300) return classifyLlamaCppFailure(status, text);
      const reply = parseOpenAiChatReply(text);
      if ('detail' in reply) return failure('UPSTREAM_ERROR', status, reply.detail);
      return { ok: true, ...reply };
    },

    async health() {
      const started = now();
      try {
        const res = await upstreamFetch(fetchImpl, `${base}/v1/models`, { method: 'GET', timeoutMs: HEALTH_TIMEOUT_MS });
        await readCappedText(res);
        const latencyMs = Math.max(0, now() - started);
        return res.ok ? { ok: true, latencyMs } : { ok: false, latencyMs, detail: `/v1/models answered HTTP ${res.status}` };
      } catch (error) {
        return { ok: false, latencyMs: Math.max(0, now() - started), detail: classifyTransportError(error).detail };
      }
    },
  };
}

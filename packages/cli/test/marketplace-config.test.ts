import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  MARKETPLACE_ENABLED_ENV,
  MARKETPLACE_GATEWAY_ENABLED_ENV,
  parseMarketplaceOffering,
  parseMarketplaceUint,
  resolveMarketplaceAgentConfig,
  resolveMarketplaceGatewayConfig,
  type DkgMarketplaceConfig,
} from '../src/marketplace-config.js';

describe('parseMarketplaceUint', () => {
  it('parses decimal strings and safe-integer numbers to bigint', () => {
    expect(parseMarketplaceUint('500000000000', 'ask')).toBe(500_000_000_000n);
    expect(parseMarketplaceUint(' 42 ', 'epoch')).toBe(42n);
    expect(parseMarketplaceUint(0, 'zero')).toBe(0n);
    expect(parseMarketplaceUint(1000, 'units')).toBe(1000n);
    // A uint96 ask comfortably above 2^53 must survive losslessly as a string.
    expect(parseMarketplaceUint('79228162514264337593543950335', 'ask')).toBe(2n ** 96n - 1n);
  });

  it('rejects numbers beyond JSON safe-integer range (already rounded by the parser)', () => {
    expect(() => parseMarketplaceUint(2 ** 53, 'ask')).toThrow(/ask must be a non-negative integer/);
  });

  it('rejects negatives, decimals, hex and junk, naming the field', () => {
    expect(() => parseMarketplaceUint(-1, 'budget')).toThrow(/budget/);
    expect(() => parseMarketplaceUint('1.5', 'budget')).toThrow(/budget must be a non-negative decimal integer string/);
    expect(() => parseMarketplaceUint('0x10', 'budget')).toThrow(/budget/);
    expect(() => parseMarketplaceUint(undefined, 'budget')).toThrow(/budget/);
    expect(() => parseMarketplaceUint('', 'budget')).toThrow(/budget/);
  });
});

describe('parseMarketplaceOffering', () => {
  const valid = {
    offeringLocalId: 'devnet-llm',
    serviceType: 'inference',
    unit: 'token',
    askPerUnitWei: '500000000000',
  };

  it('maps wei/unit strings to bigint and keeps optional fields only when present', () => {
    const offering = parseMarketplaceOffering(
      { ...valid, modelId: 'stub-1', capacityUnitsPerMin: 60000, expiresAt: 1793577600, executor: 'stub-inference' },
      'offerings[0]',
    );
    expect(offering).toEqual({
      offeringLocalId: 'devnet-llm',
      serviceType: 'inference',
      modelId: 'stub-1',
      unit: 'token',
      askPerUnitWei: 500_000_000_000n,
      capacityUnitsPerMin: 60_000n,
      expiresAt: 1793577600,
      executor: 'stub-inference',
    });
    const minimal = parseMarketplaceOffering(valid, 'offerings[0]');
    expect(minimal).toEqual({
      offeringLocalId: 'devnet-llm',
      serviceType: 'inference',
      unit: 'token',
      askPerUnitWei: 500_000_000_000n,
    });
    expect('modelId' in minimal).toBe(false);
    expect('capacityUnitsPerMin' in minimal).toBe(false);
  });

  it('rejects malformed fields with the offending key path', () => {
    expect(() => parseMarketplaceOffering('nope', 'offerings[0]')).toThrow(/offerings\[0\] must be an offering object/);
    expect(() => parseMarketplaceOffering({ ...valid, serviceType: 'chat' }, 'offerings[1]'))
      .toThrow(/offerings\[1\]\.serviceType must be one of inference, query, reasoning, graph-ml/);
    expect(() => parseMarketplaceOffering({ ...valid, unit: 'calls' }, 'offerings[0]'))
      .toThrow(/offerings\[0\]\.unit/);
    expect(() => parseMarketplaceOffering({ ...valid, askPerUnitWei: '0.5' }, 'offerings[0]'))
      .toThrow(/offerings\[0\]\.askPerUnitWei/);
    expect(() => parseMarketplaceOffering({ ...valid, offeringLocalId: '' }, 'offerings[0]'))
      .toThrow(/offerings\[0\]\.offeringLocalId/);
    expect(() => parseMarketplaceOffering({ ...valid, executor: 'real-llm' }, 'offerings[0]'))
      .toThrow(/offerings\[0\]\.executor/);
    expect(() => parseMarketplaceOffering({ ...valid, expiresAt: -5 }, 'offerings[0]'))
      .toThrow(/offerings\[0\]\.expiresAt/);
  });
});

describe('resolveMarketplaceAgentConfig', () => {
  it('returns undefined with no block and no env — the runtime stays off', () => {
    expect(resolveMarketplaceAgentConfig(undefined, undefined)).toBeUndefined();
  });

  it(`${MARKETPLACE_ENABLED_ENV}=1 enables with no config block at all`, () => {
    expect(resolveMarketplaceAgentConfig(undefined, '1')).toEqual({ enabled: true });
  });

  it('the environment override wins over the config flag, both ways', () => {
    expect(resolveMarketplaceAgentConfig({ enabled: true }, '0')?.enabled).toBe(false);
    expect(resolveMarketplaceAgentConfig({ enabled: false }, 'true')?.enabled).toBe(true);
  });

  it('a junk environment value fails loudly instead of picking a side', () => {
    expect(() => resolveMarketplaceAgentConfig({ enabled: true }, 'yes'))
      .toThrow(new RegExp(MARKETPLACE_ENABLED_ENV));
  });

  it('maps the full block: offerings, batching exposure and buyer knobs', () => {
    const config: DkgMarketplaceConfig = {
      enabled: true,
      seller: {
        offerings: [{
          offeringLocalId: 'devnet-knowledge',
          serviceType: 'query',
          unit: 'query-unit',
          askPerUnitWei: '15000000000000',
        }],
        flushIntervalMs: 2000,
        batching: { maxBatchSize: 10, maxDelayMs: 4000, maxBuyerExposureWei: '1000000000000000000' },
      },
      buyer: { authTtlSeconds: 300, quoteTimeoutMs: 1500, serveTimeoutMs: 20000, maxQuoteProbes: 4 },
    };
    const resolved = resolveMarketplaceAgentConfig(config, undefined);
    expect(resolved).toEqual({
      enabled: true,
      seller: {
        offerings: [{
          offeringLocalId: 'devnet-knowledge',
          serviceType: 'query',
          unit: 'query-unit',
          askPerUnitWei: 15_000_000_000_000n,
        }],
        flushIntervalMs: 2000,
        batching: { maxBatchSize: 10, maxDelayMs: 4000, maxBuyerExposureWei: 10n ** 18n },
      },
      buyer: { authTtlSeconds: 300, quoteTimeoutMs: 1500, serveTimeoutMs: 20000, maxQuoteProbes: 4 },
    });
  });

  it('a present-but-disabled block is still parsed so typos fail at boot', () => {
    expect(() => resolveMarketplaceAgentConfig({
      enabled: false,
      seller: { offerings: [{ offeringLocalId: 'x', serviceType: 'inference', unit: 'token', askPerUnitWei: 'ten' }] },
    } as DkgMarketplaceConfig, undefined)).toThrow(/marketplace\.seller\.offerings\[0\]\.askPerUnitWei/);
    expect(resolveMarketplaceAgentConfig({ enabled: false }, undefined)).toEqual({ enabled: false });
  });

  it('rejects malformed seller/buyer shapes, naming the config key', () => {
    expect(() => resolveMarketplaceAgentConfig({ enabled: true, seller: [] as never }, undefined))
      .toThrow(/marketplace\.seller must be an object/);
    expect(() => resolveMarketplaceAgentConfig({ enabled: true, seller: { offerings: {} as never } }, undefined))
      .toThrow(/marketplace\.seller\.offerings must be an array/);
    expect(() => resolveMarketplaceAgentConfig({ enabled: true, buyer: { authTtlSeconds: -1 } }, undefined))
      .toThrow(/marketplace\.buyer\.authTtlSeconds/);
    expect(() => resolveMarketplaceAgentConfig(
      { enabled: true, seller: { batching: { maxBuyerExposureWei: 2 ** 53 } } },
      undefined,
    )).toThrow(/marketplace\.seller\.batching\.maxBuyerExposureWei/);
  });
});

describe('chat-connector offerings (structural parse)', () => {
  const chatOffering = {
    offeringLocalId: 'devnet-chat',
    serviceType: 'inference',
    unit: 'token',
    modelId: 'stub-chat',
    askPerUnitWei: '500000000000',
    executor: 'chat-connector',
    connector: {
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:18080/v1',
      upstreamModel: 'stub-chat',
      secretEnvFile: '/abs/.devnet/node1/marketplace/.secrets/llm-stub.env',
      toolTransport: 'native',
      maxTokensField: 'max_tokens',
      contextLength: '32768',
      timeoutMs: 120000,
    },
    metering: { tokenizer: { kind: 'stub-words-v1' } },
    model: { displayName: 'Stub Chat', contextLength: '32768', family: 'stub', quantization: 'none' },
    allowedBuyers: [],
  };

  it('maps the §12 example into the agent shape (bigint context lengths)', () => {
    expect(parseMarketplaceOffering(chatOffering, 'o')).toEqual({
      offeringLocalId: 'devnet-chat',
      serviceType: 'inference',
      modelId: 'stub-chat',
      unit: 'token',
      askPerUnitWei: 500_000_000_000n,
      executor: 'chat-connector',
      connector: {
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:18080/v1',
        upstreamModel: 'stub-chat',
        secretEnvFile: '/abs/.devnet/node1/marketplace/.secrets/llm-stub.env',
        toolTransport: 'native',
        maxTokensField: 'max_tokens',
        contextLength: 32768n,
        timeoutMs: 120000,
      },
      metering: { tokenizer: { kind: 'stub-words-v1' } },
      allowedBuyers: [],
      model: { displayName: 'Stub Chat', family: 'stub', contextLength: 32768n, quantization: 'none' },
    });
  });

  it('parses llamacpp and codex-oauth connectors; allowedBuyers are checksummed', () => {
    const llama = parseMarketplaceOffering({
      ...chatOffering,
      connector: { kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8081', ggufPath: '/models/q.gguf', settings: { seed: 7, temperature: '0', ctx: 8192 } },
      metering: { tokenizer: { kind: 'hf-bpe-v1', path: '/models/tokenizer.json' } },
    }, 'o');
    expect(llama.connector).toEqual({
      kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8081', ggufPath: '/models/q.gguf', settings: { seed: 7, temperature: '0', ctx: 8192 },
    });
    expect(llama.metering).toEqual({ tokenizer: { kind: 'hf-bpe-v1', path: '/models/tokenizer.json' } });
    const codex = parseMarketplaceOffering({
      ...chatOffering,
      connector: { kind: 'codex-oauth', upstreamModel: 'gpt-5-codex', reasoningEffort: 'low', acknowledgeSubscriptionScope: true },
      metering: { tokenizer: { kind: 'tiktoken-o200k-v1', path: '/tok/o200k_base.tiktoken' } },
      allowedBuyers: ['0x' + 'ab'.repeat(20)],
    }, 'o');
    expect(codex.connector).toEqual({ kind: 'codex-oauth', upstreamModel: 'gpt-5-codex', reasoningEffort: 'low', acknowledgeSubscriptionScope: true });
    expect(codex.allowedBuyers).toEqual([ethers.getAddress('0x' + 'ab'.repeat(20))]);
    // An offering without a connector keeps the old shape.
    expect(parseMarketplaceOffering({ offeringLocalId: 'q', serviceType: 'query', unit: 'query-unit', askPerUnitWei: '1' }, 'o'))
      .toEqual({ offeringLocalId: 'q', serviceType: 'query', unit: 'query-unit', askPerUnitWei: 1n });
  });

  it.each([
    [{ connector: { ...chatOffering.connector, secretEnvFile: 'relative/llm.env' } }, /connector\.secretEnvFile must be an absolute file path/],
    [{ connector: { kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8081', ggufPath: 'models/q.gguf', settings: { seed: 1, temperature: '0', ctx: 1 } } }, /ggufPath must be an absolute/],
    [{ connector: { kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8081', ggufPath: '/q.gguf', settings: { seed: 1, temperature: 0.7, ctx: 1 } } }, /settings\.temperature must be a decimal string/],
    [{ connector: { kind: 'codex-oauth', upstreamModel: 'gpt-5', acknowledgeSubscriptionScope: 'yes' } }, /acknowledgeSubscriptionScope must be the literal true/],
    [{ connector: { kind: 'codex-oauth', upstreamModel: 'gpt-5' } }, /acknowledgeSubscriptionScope must be the literal true/],
    [{ connector: { kind: 'codex-oauth', upstreamModel: 'gpt-5', acknowledgeSubscriptionScope: true, authFile: './auth.json' } }, /authFile must be an absolute/],
    [{ connector: { ...chatOffering.connector, baseUrl: 'ftp://host/v1' } }, /baseUrl must be an http or https URL/],
    [{ connector: { ...chatOffering.connector, baseUrl: 'https://user:pw@api.example/v1' } }, /must not carry credentials/],
    [{ connector: { ...chatOffering.connector, baseUrl: 'https://api.example/v1?x=1' } }, /must not carry credentials, a query/],
    [{ connector: { ...chatOffering.connector, baseUrl: 'not a url' } }, /baseUrl is not a valid URL/],
    [{ connector: { ...chatOffering.connector, toolTransport: 'magic' } }, /toolTransport must be one of native, prompt, none/],
    [{ connector: { ...chatOffering.connector, maxTokensField: 'max_output_tokens' } }, /maxTokensField must be one of/],
    [{ connector: { ...chatOffering.connector, timeoutMs: 999 } }, /timeoutMs must be an integer 1000\.\.600000/],
    [{ connector: { ...chatOffering.connector, contextLength: 2 ** 53 } }, /contextLength must be a positive decimal integer string/],
    [{ connector: { ...chatOffering.connector, secretEnvKey: 'BAD KEY' } }, /secretEnvKey must be an environment-variable name/],
    [{ connector: { ...chatOffering.connector, apiKey: 'sk-live-secret' } }, /connector\.apiKey is not a recognised connector field/],
    [{ connector: { ...chatOffering.connector, kind: 'anthropic' } }, /connector\.kind must be one of/],
    [{ metering: { tokenizer: { kind: 'hf-bpe-v1' } } }, /metering\.tokenizer\.path must be an absolute file path/],
    [{ metering: { tokenizer: { kind: 'stub-words-v1', path: '/x' } } }, /path must be omitted for stub-words-v1/],
    [{ metering: { tokenizer: { kind: 'sentencepiece' } } }, /metering\.tokenizer\.kind must be one of/],
    [{ allowedBuyers: ['not-an-address'] }, /allowedBuyers\[0\] must be a 0x-prefixed EVM address/],
    [{ executor: 'stub-inference' }, /connector requires executor chat-connector/],
    [{ connector: undefined }, /connector is required for executor chat-connector/],
    [{ model: { contextLength: 'many' } }, /model\.contextLength/],
  ])('%j is rejected', (patch, error) => {
    expect(() => parseMarketplaceOffering({ ...chatOffering, ...patch }, 'o')).toThrow(error);
  });

  it('a credential-shaped unknown key is named, never echoed', () => {
    let message = '';
    try {
      parseMarketplaceOffering({ ...chatOffering, connector: { ...chatOffering.connector, apiKey: 'sk-live-very-secret' } }, 'o');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('apiKey');
    expect(message).not.toContain('sk-live-very-secret');
  });

  it('metering applies only to chat-connector offerings', () => {
    expect(() => parseMarketplaceOffering({
      offeringLocalId: 'x', serviceType: 'inference', unit: 'token', askPerUnitWei: '1', metering: { tokenizer: { kind: 'stub-words-v1' } },
    }, 'o')).toThrow(/metering applies only to chat-connector offerings/);
  });
});

describe('seller query guards and buyer recount/tokenizer config', () => {
  it('maps queryGuards, chatServeTimeoutMs, tokenizers and recountPolicy', () => {
    expect(resolveMarketplaceAgentConfig({
      enabled: true,
      seller: { queryGuards: { timeoutMs: 5000, maxRows: 500 } },
      buyer: {
        chatServeTimeoutMs: 200000,
        tokenizers: [{ kind: 'hf-bpe-v1', path: '/abs/tokenizer.json' }, { kind: 'tiktoken-o200k-v1', path: '/abs/o200k.tiktoken' }],
        recountPolicy: { window: 20, deprioritizeAt: 1, denyAt: 3, denyCooldownSeconds: 86400 },
        gateway: { enabled: true, defaultMaxTokens: 256, maxBodyBytes: 4194304, maxConcurrent: 16 },
      },
    }, undefined)).toEqual({
      enabled: true,
      seller: { queryGuards: { timeoutMs: 5000, maxRows: 500 } },
      buyer: {
        chatServeTimeoutMs: 200000,
        tokenizers: [{ kind: 'hf-bpe-v1', path: '/abs/tokenizer.json' }, { kind: 'tiktoken-o200k-v1', path: '/abs/o200k.tiktoken' }],
        recountPolicy: { window: 20, deprioritizeAt: 1, denyAt: 3, denyCooldownSeconds: 86400 },
      },
    });
  });

  it.each([
    [{ seller: { queryGuards: { timeoutMs: 0 } } }, /marketplace\.seller\.queryGuards\.timeoutMs/],
    [{ seller: { queryGuards: { maxRows: -1 } } }, /marketplace\.seller\.queryGuards\.maxRows/],
    [{ buyer: { tokenizers: [{ kind: 'hf-bpe-v1', path: 'rel/tokenizer.json' }] } }, /marketplace\.buyer\.tokenizers\[0\]\.path must be an absolute/],
    [{ buyer: { tokenizers: [{ kind: 'stub-words-v1' }] } }, /stub-words-v1 is built in/],
    [{ buyer: { recountPolicy: { window: 0 } } }, /marketplace\.buyer\.recountPolicy\.window/],
    [{ buyer: { recountPolicy: { denyCooldownSeconds: -1 } } }, /denyCooldownSeconds/],
    [{ buyer: { chatServeTimeoutMs: 10 } }, /marketplace\.buyer\.chatServeTimeoutMs/],
    [{ buyer: { gateway: { maxConcurrent: 0 } } }, /marketplace\.buyer\.gateway\.maxConcurrent/],
    [{ buyer: { gateway: { maxBodyBytes: 1 } } }, /marketplace\.buyer\.gateway\.maxBodyBytes/],
    [{ buyer: { gateway: { defaultMaxTokens: 1_000_001 } } }, /marketplace\.buyer\.gateway\.defaultMaxTokens/],
    [{ buyer: { gateway: { enabled: 'yes' } } }, /marketplace\.buyer\.gateway\.enabled must be a boolean/],
  ])('%j fails at boot', (patch, error) => {
    expect(() => resolveMarketplaceAgentConfig({ enabled: false, ...patch } as DkgMarketplaceConfig, undefined)).toThrow(error);
  });
});

describe('resolveMarketplaceGatewayConfig', () => {
  const defaults = { defaultMaxTokens: 256, maxBodyBytes: 4 * 1024 * 1024, maxConcurrent: 16 };

  it('is on by default with the marketplace and off without it', () => {
    expect(resolveMarketplaceGatewayConfig({ enabled: true }, {})).toEqual(defaults);
    expect(resolveMarketplaceGatewayConfig({ enabled: false }, {})).toBeUndefined();
    expect(resolveMarketplaceGatewayConfig(undefined, {})).toBeUndefined();
    expect(resolveMarketplaceGatewayConfig(undefined, { [MARKETPLACE_ENABLED_ENV]: '1' })).toEqual(defaults);
  });

  it('config and DKG_MARKETPLACE_GATEWAY_ENABLED can switch it off (env wins both ways)', () => {
    expect(resolveMarketplaceGatewayConfig({ enabled: true, buyer: { gateway: { enabled: false } } }, {})).toBeUndefined();
    expect(resolveMarketplaceGatewayConfig({ enabled: true }, { [MARKETPLACE_GATEWAY_ENABLED_ENV]: '0' })).toBeUndefined();
    expect(resolveMarketplaceGatewayConfig(
      { enabled: true, buyer: { gateway: { enabled: false } } },
      { [MARKETPLACE_GATEWAY_ENABLED_ENV]: 'true' },
    )).toEqual(defaults);
    expect(() => resolveMarketplaceGatewayConfig({ enabled: true }, { [MARKETPLACE_GATEWAY_ENABLED_ENV]: 'maybe' }))
      .toThrow(/DKG_MARKETPLACE_GATEWAY_ENABLED must be one of 1, 0, true, or false/);
  });

  it('carries the tunables', () => {
    expect(resolveMarketplaceGatewayConfig({
      enabled: true,
      buyer: { gateway: { defaultMaxTokens: 64, maxBodyBytes: 65536, maxConcurrent: 4 } },
    }, {})).toEqual({ defaultMaxTokens: 64, maxBodyBytes: 65536, maxConcurrent: 4 });
  });
});

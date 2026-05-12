#!/usr/bin/env node
/**
 * Smoke test for the Layer 2 semantic extraction providers.
 *
 * Calls extractWithLlm() with a tiny markdown fixture and a REAL API key
 * (no fetch mocking). Prints the returned triples, model, and token
 * usage. Use this to verify that an LlmProvider's request/response
 * shape is actually accepted by the live API.
 *
 * Usage:
 *
 *   # Anthropic (default)
 *   ANTHROPIC_API_KEY=sk-ant-... node packages/cli/scripts/extraction-smoke.mjs
 *   ANTHROPIC_API_KEY=sk-ant-... node packages/cli/scripts/extraction-smoke.mjs anthropic
 *
 *   # OpenAI
 *   OPENAI_API_KEY=sk-... node packages/cli/scripts/extraction-smoke.mjs openai
 *
 *   # Override model
 *   ANTHROPIC_API_KEY=sk-ant-... node packages/cli/scripts/extraction-smoke.mjs anthropic claude-sonnet-4-6
 *
 * Prerequisite: `pnpm -r build` must have run so that
 * packages/cli/dist/extraction/llm-extractor.js exists.
 *
 * Cost: ~$0.001 per invocation against either provider.
 */

import { extractWithLlm } from '../dist/extraction/llm-extractor.js';

const MARKDOWN_FIXTURE = `---
type: ScholarlyArticle
title: A short note on solar panels
---

# A short note on solar panels

Solar panels convert sunlight into electricity via the photovoltaic effect.
A typical residential installation in California averages 6 kW peak capacity
and produces around 8,500 kWh per year. The dominant cell technology is
monocrystalline silicon, supplied by manufacturers in China and South Korea.

Tesla announced in 2024 that its V4 Megapack ships with integrated solar
inverters, reducing balance-of-system cost by approximately 12% for utility
deployments. The U.S. Department of Energy projects that residential solar
will reach grid parity in 47 states by 2027.
`;

const usage = `Usage: node packages/cli/scripts/extraction-smoke.mjs [openai|anthropic] [model]

Required env vars (depending on provider):
  OPENAI_API_KEY=sk-...          # for the OpenAI provider
  ANTHROPIC_API_KEY=sk-ant-...   # for the Anthropic provider`;

const provider = (process.argv[2] ?? 'anthropic').toLowerCase();
const modelOverride = process.argv[3]; // optional

if (provider !== 'openai' && provider !== 'anthropic') {
  console.error(`Unknown provider "${provider}".\n\n${usage}`);
  process.exit(2);
}

const apiKey = provider === 'anthropic'
  ? process.env.ANTHROPIC_API_KEY
  : process.env.OPENAI_API_KEY;

if (!apiKey) {
  const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  console.error(`Missing ${envVar} in env.\n\n${usage}`);
  process.exit(2);
}

console.error(`[smoke] Provider: ${provider}`);
if (modelOverride) console.error(`[smoke] Model override: ${modelOverride}`);
console.error(`[smoke] Fixture: ${MARKDOWN_FIXTURE.length} chars`);
console.error(`[smoke] Calling extractWithLlm()...`);

const start = Date.now();

const result = await extractWithLlm(
  {
    markdown: MARKDOWN_FIXTURE,
    agentDid: 'did:dkg:agent:0xSmokeTest',
    documentIri: 'urn:dkg:smoke:solar-panels',
  },
  {
    provider,
    apiKey,
    ...(modelOverride ? { model: modelOverride } : {}),
  },
);

const elapsedMs = Date.now() - start;

console.error(`[smoke] Completed in ${elapsedMs}ms`);
console.error('');
console.log(JSON.stringify({
  provider,
  model: result.model,
  tokensUsed: result.tokensUsed ?? null,
  tripleCount: result.triples.length,
  triples: result.triples,
}, null, 2));

if (result.triples.length === 0) {
  console.error('');
  console.error('[smoke] WARNING: zero triples returned. Check stderr above for any [openai] or [anthropic] warnings.');
  process.exit(1);
}

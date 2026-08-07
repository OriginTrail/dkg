import { describe, expect, it, vi } from 'vitest';
import { handleDragRoutes } from '../src/daemon/routes/drag.js';
import { DRAG_RULE_PREDICATE, DRAG_RULE_STATUS } from '../src/daemon/drag-reasoner.js';
import { encodeXPaymentHeader, type PaymentPayload } from '../src/daemon/payment.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const CONTEXT_GRAPH_ID = 'private-supply-chain';
const CALLER = '0x1111111111111111111111111111111111111111';

function answerResult() {
  return {
    answer: 'Northwind was flagged.',
    facts: [],
    citations: [],
    stats: {
      retrieval: 'keyword',
      verified: 0,
      factsCited: 0,
    },
  };
}

function responseStub() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writableEnded: false,
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(body?: string) {
      this.body = body ?? '';
      this.writableEnded = true;
      return this;
    },
  };
}

function createAgent(overrides: Record<string, unknown> = {}) {
  return {
    canReadContextGraph: vi.fn(async () => true),
    isPrivateContextGraph: vi.fn(async () => true),
    dragAnswerLocal: vi.fn(async () => answerResult()),
    dragAnswerNetwork: vi.fn(async () => answerResult()),
    gatherVerifiedFacts: vi.fn(async () => ({
      facts: [],
      complete: true,
      truncated: false,
      graphsSkipped: 0,
    })),
    ...overrides,
  };
}

async function postAnswer(
  body: Record<string, unknown>,
  options: {
    agent?: ReturnType<typeof createAgent>;
    config?: Record<string, unknown>;
    requestAgentAddress?: string;
    xPayment?: string;
  } = {},
) {
  const path = '/api/answer';
  const agent = options.agent ?? createAgent();
  const req = {
    method: 'POST',
    url: path,
    headers: { host: '127.0.0.1', ...(options.xPayment ? { 'x-payment': options.xPayment } : {}) },
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)),
  };
  const res = responseStub();
  const url = new URL(`http://127.0.0.1${path}`);
  const ctx = {
    req,
    res,
    agent,
    path,
    url,
    config: options.config ?? { drag: {} },
    opWallets: undefined,
    requestAgentAddress: options.requestAgentAddress ?? CALLER,
    vectorStore: {},
    embeddingProvider: null,
  } as unknown as RequestContext;

  await handleDragRoutes(ctx);
  return {
    agent,
    status: res.statusCode,
    body: JSON.parse(res.body) as Record<string, any>,
  };
}

describe('POST /api/answer authorization and validation', () => {
  it('returns 403 before retrieval when the caller cannot read the context graph', async () => {
    const agent = createAgent({ canReadContextGraph: vi.fn(async () => false) });

    const result = await postAnswer(
      { question: 'Which suppliers were flagged?', contextGraphId: CONTEXT_GRAPH_ID },
      { agent },
    );

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: `Not authorized to read context graph "${CONTEXT_GRAPH_ID}"` });
    expect(agent.canReadContextGraph).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, {
      callerAgentAddress: CALLER,
    });
    expect(agent.dragAnswerLocal).not.toHaveBeenCalled();
    expect(agent.dragAnswerNetwork).not.toHaveBeenCalled();
  });

  it.each([
    [{ scope: 'global' }, '"scope" must be "local" or "network"'],
    [{ retrieval: 'hybrid' }, '"retrieval" must be "default", "keyword", or "semantic"'],
    [{ reason: 'yes' }, '"reason" must be a boolean'],
    [{ synthesize: 1 }, '"synthesize" must be a boolean'],
    [{ rules: '{ ?s ?p ?o } => { ?s ?p ?o } .' }, '"rules" requires "reason": true'],
    [{ embedder: 'local' }, 'per-request "embedder" requires config.drag.experimentalOverrides=true'],
    [
      { simulatePrice: '0.01 USDC' },
      '"simulatePrice" requires experimental overrides and dRAG payments to be enabled',
    ],
    [
      { scope: 'network', retrieval: 'semantic' },
      '"retrieval" applies only to local scope; network responders use bounded keyword retrieval',
    ],
    [
      { scope: 'network', reason: true },
      'reasoning, rules, and synthesis currently require local scope',
    ],
    [
      { scope: 'network', synthesize: true },
      'reasoning, rules, and synthesis currently require local scope',
    ],
  ])('rejects unsupported request %j before authorization or retrieval', async (fields, error) => {
    const result = await postAnswer({
      question: 'Which suppliers were flagged?',
      contextGraphId: CONTEXT_GRAPH_ID,
      ...fields,
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error });
    expect(result.agent.canReadContextGraph).not.toHaveBeenCalled();
    expect(result.agent.dragAnswerLocal).not.toHaveBeenCalled();
    expect(result.agent.dragAnswerNetwork).not.toHaveBeenCalled();
  });

  it('rejects an unsafe context graph id before the authorization lookup', async () => {
    const result = await postAnswer({
      question: 'Which suppliers were flagged?',
      contextGraphId: 'cg> } INSERT DATA { <urn:x> <urn:y> <urn:z> } #',
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/invalid context graph id/i);
    expect(result.agent.canReadContextGraph).not.toHaveBeenCalled();
  });

  it('serves an allowed local request through the local answer path', async () => {
    const result = await postAnswer({
      question: 'Which suppliers were flagged?',
      contextGraphId: CONTEXT_GRAPH_ID,
      scope: 'local',
      retrieval: 'keyword',
      maxCitations: 12,
      maxKas: 20,
    });

    expect(result.status).toBe(200);
    expect(result.body.answer).toBe('Northwind was flagged.');
    expect(result.agent.dragAnswerLocal).toHaveBeenCalledWith(
      {
        question: 'Which suppliers were flagged?',
        contextGraphId: CONTEXT_GRAPH_ID,
        maxCitations: 12,
        maxKas: 20,
      },
      { retriever: undefined, forceKeyword: true },
    );
    expect(result.agent.dragAnswerNetwork).not.toHaveBeenCalled();
  });

  it('does not send private graph content to a model without operator opt-in', async () => {
    const result = await postAnswer({
      question: 'Which suppliers were flagged?',
      contextGraphId: CONTEXT_GRAPH_ID,
      retrieval: 'semantic',
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/private context graph model calls are disabled/);
    expect(result.agent.dragAnswerLocal).not.toHaveBeenCalled();
  });

  it('forces keyword retrieval on a private graph DEFAULT request — the node-wide semantic retriever must not be inherited', async () => {
    const result = await postAnswer({
      question: 'Which suppliers were flagged?',
      contextGraphId: CONTEXT_GRAPH_ID,
    });

    expect(result.status).toBe(200);
    expect(result.agent.dragAnswerLocal).toHaveBeenCalledWith(
      {
        question: 'Which suppliers were flagged?',
        contextGraphId: CONTEXT_GRAPH_ID,
        maxCitations: undefined,
        maxKas: undefined,
      },
      { retriever: undefined, forceKeyword: true },
    );
  });

  it('rejects an explicit experimental embedder that cannot run instead of silently answering with the default', async () => {
    const agent = createAgent({ isPrivateContextGraph: vi.fn(async () => false) });

    const result = await postAnswer(
      { question: 'Which suppliers were flagged?', contextGraphId: CONTEXT_GRAPH_ID, embedder: 'openai' },
      { agent, config: { drag: { experimentalOverrides: true } } },
    );

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/embedder "openai" is not available/);
    expect(agent.dragAnswerLocal).not.toHaveBeenCalled();
  });

  it('reports that reasoning is disabled without gathering the graph', async () => {
    const result = await postAnswer({
      question: 'Which suppliers violated policy?',
      contextGraphId: CONTEXT_GRAPH_ID,
      reason: true,
    });

    expect(result.status).toBe(200);
    expect(result.body.reasoning).toEqual({
      engine: 'eye-js',
      derived: [],
      note: 'reasoning is disabled; set config.drag.reasoning=true to opt in',
    });
    expect(result.agent.gatherVerifiedFacts).not.toHaveBeenCalled();
  });

  it('refuses reasoning over an incomplete verified fact set', async () => {
    const agent = createAgent({
      gatherVerifiedFacts: vi.fn(async () => ({
        facts: [],
        complete: false,
        truncated: true,
        graphsSkipped: 2,
      })),
    });

    const result = await postAnswer(
      {
        question: 'Which suppliers violated policy?',
        contextGraphId: CONTEXT_GRAPH_ID,
        reason: true,
      },
      { agent, config: { drag: { reasoning: true, reasoningMaxKas: 40 } } },
    );

    expect(result.status).toBe(200);
    expect(result.body.reasoning).toEqual({
      engine: 'eye-js',
      derived: [],
      note: 'reasoning refused: verified fact set is incomplete (2 skipped, truncated=true)',
    });
    expect(agent.gatherVerifiedFacts).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, { cap: 40 });
  });

  // Managed reasoning rules: a rule-KA is status-gated and (optionally) author-governed.
  const ruleFact = (subject: string, n3: string, kaId: string, author: string) => ({
    triple: { subject, predicate: DRAG_RULE_PREDICATE, object: `"${n3}"` },
    citation: { kaId, onChain: { author } },
  });
  const statusFact = (subject: string, status: string, kaId: string, author: string) => ({
    triple: { subject, predicate: DRAG_RULE_STATUS, object: `"${status}"` },
    citation: { kaId, onChain: { author } },
  });
  const RULE_N3 = '{ ?s ?p ?o } => { ?s ?p ?o } .';

  function reasoningAgent(facts: unknown[]) {
    return createAgent({
      gatherVerifiedFacts: vi.fn(async () => ({
        facts,
        complete: true,
        truncated: false,
        graphsSkipped: 0,
      })),
    });
  }

  it('never fires a rule whose drag:ruleStatus is "disabled"', async () => {
    const agent = reasoningAgent([
      ruleFact('urn:rule:active', RULE_N3, 'ka-active', '0xaaa'),
      ruleFact('urn:rule:disabled', RULE_N3, 'ka-disabled', '0xaaa'),
      statusFact('urn:rule:disabled', 'disabled', 'ka-disabled', '0xaaa'),
    ]);

    const result = await postAnswer(
      { question: 'Which suppliers violated policy?', contextGraphId: CONTEXT_GRAPH_ID, reason: true },
      { agent, config: { drag: { reasoning: true } } },
    );

    expect(result.status).toBe(200);
    const applied = (result.body.reasoning.rules ?? []) as Array<{ kaId: string }>;
    expect(applied.map((c) => c.kaId)).toEqual(['ka-active']);
  });

  it('ignores a "disabled" status published by a different author than the rule', async () => {
    const agent = reasoningAgent([
      ruleFact('urn:rule:trusted', RULE_N3, 'ka-trusted', '0xaaa'),
      // Attacker on the public CG publishes a status fact about the victim's rule.
      statusFact('urn:rule:trusted', 'disabled', 'ka-attacker', '0xbbb'),
    ]);

    const result = await postAnswer(
      { question: 'Which suppliers violated policy?', contextGraphId: CONTEXT_GRAPH_ID, reason: true },
      { agent, config: { drag: { reasoning: true } } },
    );

    expect(result.status).toBe(200);
    const applied = (result.body.reasoning.rules ?? []) as Array<{ kaId: string }>;
    expect(applied.map((c) => c.kaId)).toEqual(['ka-trusted']);
  });

  it('honors a "disabled" status from an allow-listed author for another author\'s rule', async () => {
    const agent = reasoningAgent([
      ruleFact('urn:rule:governed', RULE_N3, 'ka-governed', '0xAbCdef0000000000000000000000000000000001'),
      statusFact('urn:rule:governed', 'disabled', 'ka-governor', '0xABCDEF0000000000000000000000000000000009'),
    ]);

    const result = await postAnswer(
      { question: 'Which suppliers violated policy?', contextGraphId: CONTEXT_GRAPH_ID, reason: true },
      {
        agent,
        config: {
          drag: {
            reasoning: true,
            reasoningRuleAuthors: [
              '0xabcdef0000000000000000000000000000000001',
              '0xabcdef0000000000000000000000000000000009',
            ],
          },
        },
      },
    );

    expect(result.status).toBe(200);
    expect(result.body.reasoning.derived).toEqual([]);
    expect(result.body.reasoning.note).toMatch(/no rules found/);
  });

  it('does not let a squatter suppress an allow-listed author\'s rule, regardless of enumeration order', async () => {
    const trusted = ruleFact('urn:rule:trusted', RULE_N3, 'ka-trusted', '0xAbCdef0000000000000000000000000000000001');
    // Subject-squat: attacker re-publishes the same rule subject with their own
    // body. Store enumeration order is implementation-defined, so the squatter
    // must lose whether seen before OR after the trusted body.
    const squatter = ruleFact('urn:rule:trusted', '{ ?s ?p ?o } => { ?o ?p ?s } .', 'ka-squatter', '0x9999990000000000000000000000000000000002');
    const config = {
      drag: { reasoning: true, reasoningRuleAuthors: ['0xabcdef0000000000000000000000000000000001'] },
    };

    for (const facts of [[trusted, squatter], [squatter, trusted]]) {
      const result = await postAnswer(
        { question: 'Which suppliers violated policy?', contextGraphId: CONTEXT_GRAPH_ID, reason: true },
        { agent: reasoningAgent(facts), config },
      );
      expect(result.status).toBe(200);
      const applied = (result.body.reasoning.rules ?? []) as Array<{ kaId: string }>;
      expect(applied.map((c) => c.kaId)).toEqual(['ka-trusted']);
    }
  });

  it('drops a contested subject (bodies from two authors, no allowlist) in either enumeration order', async () => {
    const a = ruleFact('urn:rule:contested', RULE_N3, 'ka-author-a', '0xaaa0000000000000000000000000000000000001');
    const b = ruleFact('urn:rule:contested', '{ ?s ?p ?o } => { ?o ?p ?s } .', 'ka-author-b', '0xbbb0000000000000000000000000000000000002');

    for (const facts of [[a, b], [b, a]]) {
      const result = await postAnswer(
        { question: 'Which suppliers violated policy?', contextGraphId: CONTEXT_GRAPH_ID, reason: true },
        { agent: reasoningAgent(facts), config: { drag: { reasoning: true } } },
      );
      expect(result.status).toBe(200);
      // No enumeration-order winner: the contested rule is deterministically absent.
      expect(result.body.reasoning.derived).toEqual([]);
      expect(result.body.reasoning.note).toMatch(/no rules found/);
    }
  });

  it('resolves multiple bodies from the SAME author to their newest rule KA', async () => {
    const v1 = ruleFact('urn:rule:versioned', RULE_N3, '100', '0xaaa');
    const v2 = ruleFact('urn:rule:versioned', '{ ?s ?p ?o } => { ?s ?p ?o } . # v2', '200', '0xaaa');

    for (const facts of [[v1, v2], [v2, v1]]) {
      const result = await postAnswer(
        { question: 'Which suppliers violated policy?', contextGraphId: CONTEXT_GRAPH_ID, reason: true },
        { agent: reasoningAgent(facts), config: { drag: { reasoning: true } } },
      );
      expect(result.status).toBe(200);
      const applied = (result.body.reasoning.rules ?? []) as Array<{ kaId: string }>;
      expect(applied.map((c) => c.kaId)).toEqual(['200']);
    }
  });

  it('trusts only allow-listed rule authors when reasoningRuleAuthors is set (case-insensitive)', async () => {
    const agent = reasoningAgent([
      ruleFact('urn:rule:trusted', RULE_N3, 'ka-trusted', '0xAbCdef0000000000000000000000000000000001'),
      ruleFact('urn:rule:planted', RULE_N3, 'ka-planted', '0x9999990000000000000000000000000000000002'),
    ]);

    const result = await postAnswer(
      { question: 'Which suppliers violated policy?', contextGraphId: CONTEXT_GRAPH_ID, reason: true },
      {
        agent,
        config: {
          drag: {
            reasoning: true,
            reasoningRuleAuthors: ['0xABCDEF0000000000000000000000000000000001'],
          },
        },
      },
    );

    expect(result.status).toBe(200);
    const applied = (result.body.reasoning.rules ?? []) as Array<{ kaId: string }>;
    expect(applied.map((c) => c.kaId)).toEqual(['ka-trusted']);
  });

  it('reports no rules when the governance allowlist excludes every discovered rule', async () => {
    const agent = reasoningAgent([
      ruleFact('urn:rule:planted', RULE_N3, 'ka-planted', '0x9999990000000000000000000000000000000002'),
    ]);

    const result = await postAnswer(
      { question: 'Which suppliers violated policy?', contextGraphId: CONTEXT_GRAPH_ID, reason: true },
      {
        agent,
        config: {
          drag: { reasoning: true, reasoningRuleAuthors: ['0xabcdef0000000000000000000000000000000001'] },
        },
      },
    );

    expect(result.status).toBe(200);
    expect(result.body.reasoning.derived).toEqual([]);
    expect(result.body.reasoning.note).toMatch(/no rules found/);
    expect(result.body.reasoning.rules).toBeUndefined();
  });

  it('runs a request-bound, single-use 402 challenge through the route', async () => {
    const request = {
      question: 'Which suppliers were flagged?',
      contextGraphId: CONTEXT_GRAPH_ID,
      simulatePrice: '0.01 USDC',
    };
    const config = { drag: { payments: { enabled: true }, experimentalOverrides: true } };
    const challenged = await postAnswer(request, { config });
    expect(challenged.status).toBe(402);
    const required = challenged.body.accepts[0] as {
      scheme: 'exact'; network: string; asset: string; amount: string; payTo: string; nonce: string; resource: string;
    };
    expect(required.resource).toMatch(/^\/api\/answer#[0-9a-f]{64}$/);
    const payment: PaymentPayload = {
      x402Version: 1,
      scheme: required.scheme,
      network: required.network,
      asset: required.asset,
      amount: required.amount,
      payTo: required.payTo,
      nonce: required.nonce,
    };
    const header = encodeXPaymentHeader(payment);
    const paid = await postAnswer(request, { config, xPayment: header });
    expect(paid.status).toBe(200);
    expect(paid.body.settlement).toMatchObject({ ok: true, asset: 'USDC', amount: '0.01' });

    const replay = await postAnswer(request, { config, xPayment: header });
    expect(replay.status).toBe(402);
    expect(replay.body.reason).toMatch(/unknown|expired|already used/);
  });

  it('cannot reuse a challenge for a more expensive execution mode', async () => {
    const request = {
      question: 'Which suppliers were flagged?',
      contextGraphId: CONTEXT_GRAPH_ID,
      simulatePrice: '0.01 USDC',
    };
    const config = {
      drag: {
        payments: { enabled: true },
        experimentalOverrides: true,
        reasoning: true,
      },
    };
    const challenged = await postAnswer(request, { config });
    const required = challenged.body.accepts[0] as {
      scheme: 'exact'; network: string; asset: string; amount: string; payTo: string; nonce: string;
    };
    const header = encodeXPaymentHeader({
      x402Version: 1,
      scheme: required.scheme,
      network: required.network,
      asset: required.asset,
      amount: required.amount,
      payTo: required.payTo,
      nonce: required.nonce,
    });

    const changed = await postAnswer({ ...request, reason: true }, { config, xPayment: header });

    expect(changed.status).toBe(402);
    expect(changed.body.reason).toMatch(/does not match this request/);
  });
});

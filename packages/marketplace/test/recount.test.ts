import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST,
  createHfBpeEngine,
  createStubWordsEngine,
  DEFAULT_RECOUNT_POLICY,
  QUERY_COST_SCHEDULE_V1,
  QUERY_COST_SCHEDULE_V1_DIGEST,
  recountChat,
  recountQuery,
  SellerStandingBook,
  STUB_WORDS_DIGEST,
  type ChatMessage,
  type OfferMetering,
  type OfferQueryCost,
  type RecountVerdict,
} from '../src/index.js';

type Json = Record<string, unknown>;
const stub = createStubWordsEngine();
const hf = createHfBpeEngine(readFileSync(new URL('./fixtures/tiny-tokenizer.json', import.meta.url)));
const WIRE: ChatMessage[] = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'hello marketplace world' },
];
const PIN: OfferMetering = {
  basis: 'pinned',
  tokenizer: { kind: 'stub-words-v1', digest: STUB_WORDS_DIGEST },
  chatTemplate: { id: 'openai-chat-count/v1', digest: CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST },
};
const SCHEDULE: OfferQueryCost = { schedule: 'dkg-mkt-query-cost/1', digest: QUERY_COST_SCHEDULE_V1_DIGEST };
const PROBE = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5';

/** A pinned chat result; `promptUnits` lets a dishonest seller inflate a consistent block. */
function chatResult(opts: { promptUnits?: number; metering?: Json; message?: Json; finish?: string } = {}): Json {
  const promptUnits = opts.promptUnits ?? 17;
  const completionUnits = (opts.metering?.completionUnits as number | undefined) ?? 5;
  const served = promptUnits + completionUnits;
  return {
    schema: 'openai-chat-result/v1',
    model: 'stub-chat',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'STUB:WORLD MARKETPLACE HELLO :: ok', ...opts.message },
        finish_reason: opts.finish ?? 'stop',
      },
    ],
    usage: { prompt_tokens: promptUnits, completion_tokens: completionUnits, total_tokens: served },
    metering: {
      basis: 'pinned',
      tokenizer: { kind: 'stub-words-v1', digest: STUB_WORDS_DIGEST },
      chatTemplate: { id: 'openai-chat-count/v1', digest: CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST },
      promptUnits,
      toolUnits: 0,
      completionUnits,
      servedUnits: served,
      truncated: false,
      ...opts.metering,
    },
  };
}

const chat = (overrides: Partial<Parameters<typeof recountChat>[0]> = {}): RecountVerdict =>
  recountChat({
    engine: stub,
    offerMetering: PIN,
    wireMessages: WIRE,
    wireOptions: {},
    result: chatResult(),
    receiptServedUnits: 22n,
    ...overrides,
  });

function queryResult(rows: number, metering: Json = {}): Json {
  const delivery = Math.ceil(rows / 100);
  return {
    schema: 'sparql-result/v1',
    result: { bindings: Array.from({ length: rows }, (_, i) => ({ s: `s${i}` })) },
    rowCount: rows,
    metering: { scheduleDigest: QUERY_COST_SCHEDULE_V1_DIGEST, admissionUnits: 3, deliveryUnits: delivery, servedUnits: 3 + delivery, rowCount: rows, ...metering },
  };
}

const query = (overrides: Partial<Parameters<typeof recountQuery>[0]> = {}): RecountVerdict =>
  recountQuery({ sparql: PROBE, offerQueryCost: SCHEDULE, result: queryResult(2), receiptServedUnits: 4n, ...overrides });

describe('recountChat verdict rows', () => {
  it('match: an honest GV-2 delivery recounts to the receipt', () => {
    expect(chat()).toEqual({ verdict: 'match', servedUnits: 22n, recountUnits: 22n });
  });

  it('malformed result → mismatch / malformed-result without recountUnits', () => {
    expect(chat({ result: { schema: 'openai-chat-result/v1' } })).toEqual({ verdict: 'mismatch', reason: 'malformed-result', servedUnits: 22n });
    expect(chat({ result: 'not json object' })).toMatchObject({ verdict: 'mismatch', reason: 'malformed-result' });
  });

  it('provider-reported offer → unverifiable', () => {
    expect(chat({ offerMetering: { basis: 'provider-reported' } })).toEqual({
      verdict: 'unverifiable',
      reason: 'provider-reported',
      servedUnits: 22n,
    });
  });

  it('no pin → not-metered; no engine for the pin → no-engine', () => {
    expect(chat({ offerMetering: undefined })).toMatchObject({ verdict: 'unverifiable', reason: 'not-metered' });
    expect(chat({ engine: undefined })).toMatchObject({ verdict: 'unverifiable', reason: 'no-engine' });
    expect(chat({ engine: hf })).toMatchObject({ verdict: 'unverifiable', reason: 'no-engine' });
  });

  it('result tokenizer ≠ offer pin → tokenizer-drift', () => {
    const drifted = chatResult({ metering: { tokenizer: { kind: 'hf-bpe-v1', digest: hf.digest } } });
    expect(chat({ result: drifted })).toMatchObject({ verdict: 'mismatch', reason: 'tokenizer-drift' });
  });

  it('result template digest ≠ offer pin → template-drift', () => {
    const drifted = chatResult({ metering: { chatTemplate: { id: 'openai-chat-count/v1', digest: STUB_WORDS_DIGEST } } });
    expect(chat({ result: drifted })).toMatchObject({ verdict: 'mismatch', reason: 'template-drift' });
  });

  it('result metering.servedUnits ≠ receipt → metering-block-differs', () => {
    expect(chat({ receiptServedUnits: 23n })).toEqual({ verdict: 'mismatch', reason: 'metering-block-differs', servedUnits: 23n });
  });

  it('a self-consistent but inflated bill → units-differ with the buyer recount', () => {
    expect(chat({ result: chatResult({ promptUnits: 18 }), receiptServedUnits: 23n })).toEqual({
      verdict: 'mismatch',
      reason: 'units-differ',
      servedUnits: 23n,
      recountUnits: 22n,
    });
  });

  it('recounts delivered tool calls as JSON-parsed (R4) and the wire tool envelope', () => {
    const toolCalls = [{ id: 'call_stub_1', type: 'function', function: { name: 'lookup', arguments: '{"echo":3}' } }];
    const options = { tools: [{ type: 'function' as const, function: { name: 'lookup' } }], toolChoice: 'required' as const };
    const toolUnits = stub.encodeCount(
      JSON.stringify({ messageMetadata: [{}, {}], tools: options.tools, tool_choice: options.toolChoice }),
    );
    const completionUnits = stub.encodeCount(JSON.stringify(toolCalls));
    const served = 17 + toolUnits + completionUnits;
    const result = {
      ...chatResult({ message: { content: null, tool_calls: toolCalls }, finish: 'tool_calls' }),
      usage: { prompt_tokens: 17 + toolUnits, completion_tokens: completionUnits, total_tokens: served },
      metering: { ...(chatResult().metering as Json), toolUnits, completionUnits, servedUnits: served },
    };
    expect(recountChat({ engine: stub, offerMetering: PIN, wireMessages: WIRE, wireOptions: options, result, receiptServedUnits: BigInt(served) })).toEqual(
      { verdict: 'match', servedUnits: BigInt(served), recountUnits: BigInt(served) },
    );
  });
});

describe('recountQuery verdict rows', () => {
  it('match: admission + delivery(countResultRows)', () => {
    expect(query()).toEqual({ verdict: 'match', servedUnits: 4n, recountUnits: 4n });
    expect(query({ result: queryResult(0), receiptServedUnits: 3n })).toMatchObject({ verdict: 'match', recountUnits: 3n });
  });

  it('an aborted result recounts to admission only', () => {
    const aborted = { ...queryResult(0), result: null, metering: { ...(queryResult(0).metering as Json), aborted: { reason: 'timeout' } } };
    expect(query({ result: aborted, receiptServedUnits: 3n })).toEqual({ verdict: 'match', servedUnits: 3n, recountUnits: 3n });
  });

  it('no queryCost group → not-metered without parsing (a legacy { result } is never malformed)', () => {
    expect(query({ offerQueryCost: undefined, result: { result: { bindings: [] } } })).toEqual({
      verdict: 'unverifiable',
      reason: 'not-metered',
      servedUnits: 4n,
    });
  });

  it('a schedule other than V1 → schedule-drift', () => {
    expect(query({ offerQueryCost: { ...SCHEDULE, digest: STUB_WORDS_DIGEST } })).toMatchObject({ verdict: 'unverifiable', reason: 'schedule-drift' });
    expect(query({ offerQueryCost: { ...SCHEDULE, schedule: 'dkg-mkt-query-cost/2' } })).toMatchObject({ reason: 'schedule-drift' });
    expect(query({ schedule: { ...QUERY_COST_SCHEDULE_V1, base: 5 } })).toMatchObject({ reason: 'schedule-drift' });
  });

  it('malformed result → mismatch; block ≠ receipt → metering-block-differs; inflated → units-differ', () => {
    expect(query({ result: { result: {} } })).toMatchObject({ verdict: 'mismatch', reason: 'malformed-result' });
    expect(query({ receiptServedUnits: 5n })).toMatchObject({ verdict: 'mismatch', reason: 'metering-block-differs' });
    const inflated = queryResult(2, { admissionUnits: 4, servedUnits: 5 });
    expect(query({ result: inflated, receiptServedUnits: 5n })).toEqual({
      verdict: 'mismatch',
      reason: 'units-differ',
      servedUnits: 5n,
      recountUnits: 4n,
    });
  });

  it('an oversized query cannot be metered by the schedule', () => {
    expect(query({ sparql: `${PROBE} #${'x'.repeat(9000)}` })).toMatchObject({ verdict: 'unverifiable', reason: 'not-metered' });
  });
});

describe('SellerStandingBook', () => {
  const match: RecountVerdict = { verdict: 'match', servedUnits: 22n, recountUnits: 22n };
  const over: RecountVerdict = { verdict: 'mismatch', reason: 'units-differ', servedUnits: 23n, recountUnits: 22n };
  const under: RecountVerdict = { verdict: 'mismatch', reason: 'units-differ', servedUnits: 20n, recountUnits: 22n };
  const malformed: RecountVerdict = { verdict: 'mismatch', reason: 'malformed-result', servedUnits: 22n };
  const unverifiable: RecountVerdict = { verdict: 'unverifiable', reason: 'provider-reported', servedUnits: 22n };
  const T = 1_800_000_000;

  it('defaults', () => {
    expect(DEFAULT_RECOUNT_POLICY).toEqual({ window: 20, deprioritizeAt: 1, denyAt: 3, denyCooldownSeconds: 86_400 });
    expect(new SellerStandingBook().standing(9n, T)).toBe('trusted');
  });

  it('0 → 1 → 3 mismatches: trusted → deprioritized → denied; a malformed result moves standing', () => {
    const book = new SellerStandingBook();
    expect(book.record(1n, match, T)).toBe('trusted');
    expect(book.record(1n, over, T + 1)).toBe('deprioritized');
    expect(book.record(1n, under, T + 2)).toBe('deprioritized');
    expect(book.record(1n, malformed, T + 3)).toBe('denied');
    expect(book.standings(T + 4)).toEqual(new Map([['1', 'denied']]));
    const [record] = book.snapshot(T + 4);
    expect(record).toMatchObject({
      sellerIdentityId: '1',
      recounted: 4,
      matches: 1,
      mismatches: 3,
      unverifiable: 0,
      overbilledUnits: 1n,
      underbilledUnits: 2n,
      recent: ['match', 'mismatch', 'mismatch', 'mismatch'],
      lastMismatchAt: T + 3,
      lastVerdictAt: T + 3,
      standing: 'denied',
    });
  });

  it('denial expires through the cool-down, then 20 clean recounts restore trust', () => {
    const book = new SellerStandingBook();
    for (let i = 0; i < 3; i++) book.record(3n, over, T + i);
    expect(book.standing(3n, T + 2 + 86_399)).toBe('denied');
    expect(book.standing(3n, T + 2 + 86_400)).toBe('deprioritized');
    const later = T + 100_000;
    for (let i = 0; i < 19; i++) expect(book.record(3n, match, later + i)).toBe('deprioritized');
    expect(book.record(3n, match, later + 19)).toBe('trusted');
    expect(book.snapshot(later + 20)[0].recent).toHaveLength(20);
  });

  it('unverifiable verdicts never move standing', () => {
    const book = new SellerStandingBook();
    for (let i = 0; i < 50; i++) expect(book.record(4n, unverifiable, T + i)).toBe('trusted');
    book.record(4n, over, T + 60);
    for (let i = 0; i < 50; i++) expect(book.record(4n, unverifiable, T + 61 + i)).toBe('deprioritized');
    expect(book.snapshot(T + 200)[0]).toMatchObject({ unverifiable: 100, recent: ['mismatch'] });
  });

  it('honours a custom policy and validates it', () => {
    const book = new SellerStandingBook({ window: 2, deprioritizeAt: 2, denyAt: 2, denyCooldownSeconds: 10 });
    book.record(5n, over, T);
    expect(book.standing(5n, T)).toBe('trusted');
    book.record(5n, over, T + 1);
    expect(book.standing(5n, T + 1)).toBe('denied');
    expect(book.standing(5n, T + 11)).toBe('deprioritized');
    book.record(5n, match, T + 12);
    book.record(5n, match, T + 13);
    expect(book.standing(5n, T + 13)).toBe('trusted');
    expect(() => new SellerStandingBook({ window: 0 })).toThrow('window');
    expect(() => new SellerStandingBook({ denyCooldownSeconds: -1 })).toThrow('denyCooldownSeconds');
  });

  it('reset clears a seller; standings cover known sellers only', () => {
    const book = new SellerStandingBook();
    book.record(1n, over, T);
    book.record(2n, match, T);
    expect(book.standings(T)).toEqual(new Map([['1', 'deprioritized'], ['2', 'trusted']]));
    expect(book.reset(1n)).toBe(true);
    expect(book.reset(1n)).toBe(false);
    expect(book.standing(1n, T)).toBe('trusted');
    expect(() => book.record(-1n, match, T)).toThrow('non-negative');
  });

  it('JSON round trip preserves records and standing; malformed books throw', () => {
    const book = new SellerStandingBook();
    for (let i = 0; i < 3; i++) book.record(7n, over, T + i);
    book.record(8n, unverifiable, T);
    const json = JSON.parse(JSON.stringify(book.toJSON()));
    expect(json.sellers[0]).toMatchObject({ sellerIdentityId: '7', overbilledUnits: '3', underbilledUnits: '0' });
    const restored = new SellerStandingBook(undefined, json);
    expect(restored.snapshot(T + 5)).toEqual(book.snapshot(T + 5));
    expect(restored.toJSON()).toEqual(book.toJSON());
    // A smaller window on reload trims history.
    expect(new SellerStandingBook({ window: 1 }, json).snapshot(T + 5)[0].recent).toEqual(['mismatch']);

    const bad: unknown[] = [
      { version: 2, sellers: [] },
      { version: 1 },
      { version: 1, sellers: [{ ...json.sellers[0], overbilledUnits: 3 }] },
      { version: 1, sellers: [{ ...json.sellers[0], recent: ['maybe'] }] },
      { version: 1, sellers: [{ ...json.sellers[0], sellerIdentityId: '-1' }] },
      { version: 1, sellers: [{ ...json.sellers[0], matches: -1 }] },
      { version: 1, sellers: [json.sellers[0], json.sellers[0]] },
    ];
    for (const raw of bad) expect(() => new SellerStandingBook(undefined, raw as never), JSON.stringify(raw)).toThrow();
  });
});

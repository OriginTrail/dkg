import { describe, it, expect, vi, afterEach } from 'vitest';
import { synthesizeAnswer } from '../src/daemon/drag-synthesize.js';
import type { DragFact } from '@origintrail-official/dkg-agent';

const facts: DragFact[] = [
  { subject: 'urn:supplier:northwind', predicate: 'http://schema.org/auditStatus', object: '"flagged"' } as DragFact,
];
const llm = { apiKey: 'k', model: 'gpt-test', baseURL: 'http://llm.test/v1' };

afterEach(() => vi.restoreAllMocks());

describe('synthesizeAnswer — grounded prose, best-effort', () => {
  it('returns the model prose and grounds the prompt in the supplied facts', async () => {
    let captured: any;
    global.fetch = vi.fn(async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Northwind was flagged.' } }] }) } as any;
    });
    const out = await synthesizeAnswer('who was flagged?', facts, llm);
    expect(out).toBe('Northwind was flagged.');
    // grounded: a strict system instruction + the facts both reach the model
    expect(captured.messages[0].content).toMatch(/only from a list of VERIFIED facts/i);
    expect(JSON.stringify(captured.messages)).toContain('flagged');
    expect(captured.temperature).toBe(0);
  });

  it('returns null on a non-OK response (caller keeps the structured answer)', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as any);
    expect(await synthesizeAnswer('q', facts, llm)).toBeNull();
  });

  it('never calls the model when there are no facts', async () => {
    const f = vi.fn();
    global.fetch = f as any;
    expect(await synthesizeAnswer('q', [], llm)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

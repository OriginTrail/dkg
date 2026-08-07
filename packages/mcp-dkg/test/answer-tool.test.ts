import { beforeEach, describe, expect, it } from 'vitest';
import type { DragAnswerResult } from '../src/client.js';
import { registerAnswerTool } from '../src/tools/answer.js';
import { FakeClient, FakeServer, makeConfig } from './harness.js';

const ANSWER: DragAnswerResult = {
  question: 'Which supplier was flagged?',
  contextGraphId: 'supply-cg',
  scope: 'local',
  answer: 'Northwind was flagged in the audit.',
  llm: false,
  facts: [
    {
      subject: 'urn:supplier:northwind',
      predicate: 'https://schema.org/auditStatus',
      object: '"flagged"',
      source: 1,
    },
  ],
  citations: [
    {
      ual: 'did:dkg:context-graph:supply-cg/knowledge-assets/1',
      kaId: '1234',
      contextGraphId: '77',
      servingNode: '12D3KooWAnswerPeer',
      triple: {
        subject: 'urn:supplier:northwind',
        predicate: 'https://schema.org/auditStatus',
        object: '"flagged"',
      },
      proof: {
        content: '0x010203',
        leaf: '0x1111',
        siblings: ['0xaaaa', '0xbbbb'],
        chunkId: 3,
        leafCount: 8,
      },
      onChain: {
        merkleRoot: '0x9999',
        author: '0x00000000000000000000000000000000000000a1',
        chainId: '84532',
      },
      seal: {
        merkleRoot: '0x9999',
        authorAddress: '0x00000000000000000000000000000000000000a1',
        r: '0xrrrr',
        vs: '0xvvvv',
        schemeVersion: 1,
        chainId: '84532',
        kav10Address: '0x00000000000000000000000000000000000000b2',
        reservedKaId: '1234',
      },
      checks: { merkle: true, onChain: true, authorSig: true, verified: true },
    },
  ],
  stats: {
    keywords: ['supplier', 'flagged'],
    factsCited: 1,
    verified: 1,
    kasMatched: 1,
    retrieval: 'vector:text-embedding-3-small',
    latencyMs: 42,
  },
};

describe('dkg_answer tool', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient({ answer: async () => ANSWER });
    registerAnswerTool(server.asMcpServer(), client.asDkgClient(), makeConfig({ defaultProject: 'supply-cg' }));
  });

  it('returns a concise text answer and the complete proof bundle as structured content', async () => {
    const result = await server.call('dkg_answer', {
      question: ANSWER.question,
      retrieval: 'semantic',
      maxCitations: 7,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('semantic-grounded');
    expect(result.content[0].text).toContain(ANSWER.answer);
    expect(result.content[0].text).not.toContain(ANSWER.citations[0].proof.siblings[0]);

    expect(result.structuredContent).toEqual(ANSWER);
    const structured = result.structuredContent as unknown as DragAnswerResult;
    expect(structured.citations[0].proof).toEqual(ANSWER.citations[0].proof);
    expect(structured.citations[0].seal).toEqual(ANSWER.citations[0].seal);
    expect(structured.citations[0].checks.verified).toBe(true);

    expect(client.answerCalls).toEqual([
      {
        question: ANSWER.question,
        contextGraphId: 'supply-cg',
        scope: undefined,
        retrieval: 'semantic',
        maxCitations: 7,
      },
    ]);
  });

  it('does not attach structured content to an error result', async () => {
    const failingServer = new FakeServer();
    const failingClient = new FakeClient({
      answer: async () => {
        throw new Error('daemon offline');
      },
    });
    registerAnswerTool(failingServer.asMcpServer(), failingClient.asDkgClient(), makeConfig());

    const result = await failingServer.call('dkg_answer', { question: 'What happened?' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('daemon offline');
    expect(result.structuredContent).toBeUndefined();
  });

  it('omits local-only retrieval when network scope is requested', async () => {
    const result = await server.call('dkg_answer', {
      question: 'Which supplier was flagged?',
      scope: 'network',
      retrieval: 'semantic',
    });

    expect(result.isError).toBeFalsy();
    expect(client.answerCalls).toEqual([
      {
        question: 'Which supplier was flagged?',
        contextGraphId: 'supply-cg',
        scope: 'network',
        retrieval: undefined,
        maxCitations: undefined,
      },
    ]);
  });
});

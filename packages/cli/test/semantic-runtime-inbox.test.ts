import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import {
  invokeSemanticProgramOnAuthorNode,
  registerSemanticRuntimeInboxSkill,
  SEMANTIC_RUNTIME_INBOX_SKILL_IRI,
} from '../src/semantic-runtime-inbox.js';

const CALLER_KEY = `0x${'01'.padStart(64, '0')}`;
const AUTHOR_KEY = `0x${'02'.padStart(64, '0')}`;
const CALLER = new ethers.Wallet(CALLER_KEY).address;
const AUTHOR = new ethers.Wallet(AUTHOR_KEY).address;
const CONTEXT_GRAPH = 'devnet-test';
const PROGRAM = 'urn:sr:program:remote-inbox';
const INVOCATION = '123e4567-e89b-42d3-a456-426614174099';
const SOURCE = '(strategy remote-inbox)';

function programResult() {
  return {
    type: 'bindings',
    bindings: [{
      g: `did:dkg:context-graph:${CONTEXT_GRAPH}/_verifiable_memory/${AUTHOR}/7`,
      language: '"sexpr-v1"',
      version: '"1.0.0"',
      source: JSON.stringify(SOURCE),
    }],
  };
}

function membership(overrides: Record<string, unknown> = {}) {
  return {
    isPrivateContextGraph: vi.fn(async () => true),
    getContextGraphOwner: vi.fn(async () => `did:dkg:agent:${CALLER}`),
    curatorDidMatchesChecksumAgent: vi.fn((owner: string, caller: string) =>
      owner.toLowerCase() === `did:dkg:agent:${caller}`.toLowerCase()),
    callerIsAllowlistedAgentParticipant: vi.fn(async () => false),
    canReadContextGraph: vi.fn(async () => false),
    refreshMetaFromCurator: vi.fn(async () => false),
    ...overrides,
  };
}

describe('semantic runtime DKG inbox invocation', () => {
  it.each(['wm', 'swm', 'vm'] as const)(
    'executes a private-CG Program on the author node with its %s persistence evidence',
    async (executionLayer) => {
    let inboxHandler: ((request: any, senderPeerId: string) => Promise<any>) | undefined;
    const expected = {
      invocationId: INVOCATION,
      executionIri: `urn:sr:execution:${INVOCATION}`,
      executionLayer,
      ...(executionLayer === 'vm' ? {
        executionUal: 'did:dkg:31337/0x2222222222222222222222222222222222222222/9',
      } : {}),
      persisted: true as const,
    };
    const execute = vi.fn(async (...args: any[]) => {
      expect(args[6]).toBe(executionLayer);
      expect(args[9]).toBe(CALLER);
      return expected;
    });
    const authorAgent = {
      peerId: 'peer-author',
      ...membership(),
      registerSkill: vi.fn((skillUri: string, handler: typeof inboxHandler) => {
        expect(skillUri).toBe(SEMANTIC_RUNTIME_INBOX_SKILL_IRI);
        inboxHandler = handler;
      }),
      query: vi.fn(async () => programResult()),
      listLocalAgents: () => [{ agentAddress: AUTHOR }],
      getCustodialAgentPrivateKey: (address: string) =>
        address.toLowerCase() === AUTHOR.toLowerCase() ? AUTHOR_KEY : undefined,
    } as any;
    registerSemanticRuntimeInboxSkill(authorAgent, {} as any, { enabled: true }, undefined, {
      invoke: execute as any,
    });

    const invokeSkill = vi.fn(async (
      peerId: string,
      skillUri: string,
      inputData: Uint8Array,
      options: Record<string, unknown>,
    ) => {
      expect(peerId).toBe('peer-author');
      expect(skillUri).toBe(SEMANTIC_RUNTIME_INBOX_SKILL_IRI);
      expect(options).toMatchObject({ messageId: INVOCATION, requestOwned: true });
      return inboxHandler!({ skillUri, inputData }, 'peer-sender');
    });
    const senderAgent = {
      peerId: 'peer-sender',
      ...membership(),
      query: vi.fn(async () => programResult()),
      listLocalAgents: () => [{ agentAddress: CALLER }],
      resolveLocalAgentAddress: () => CALLER,
      getCustodialAgentPrivateKey: (address: string) =>
        address.toLowerCase() === CALLER.toLowerCase() ? CALLER_KEY : undefined,
      findAgentPeerIdsByAddress: vi.fn(async () => ['peer-author']),
      invokeSkill,
    } as any;

    await expect(invokeSemanticProgramOnAuthorNode(
      senderAgent,
      {} as any,
      CONTEXT_GRAPH,
      PROGRAM,
      INVOCATION,
      'vm',
      executionLayer,
      { enabled: true },
      undefined,
      CALLER,
    )).resolves.toEqual(expected);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects public-CG remote invocation before contacting the author node', async () => {
    const invokeSkill = vi.fn();
    const senderAgent = {
      peerId: 'peer-sender',
      ...membership({ isPrivateContextGraph: vi.fn(async () => false) }),
      query: vi.fn(async () => programResult()),
      listLocalAgents: () => [{ agentAddress: CALLER }],
      resolveLocalAgentAddress: () => CALLER,
      getCustodialAgentPrivateKey: () => CALLER_KEY,
      findAgentPeerIdsByAddress: vi.fn(async () => ['peer-author']),
      invokeSkill,
    } as any;

    await expect(invokeSemanticProgramOnAuthorNode(
      senderAgent,
      {} as any,
      CONTEXT_GRAPH,
      PROGRAM,
      INVOCATION,
      'vm',
      'vm',
      { enabled: true },
      undefined,
      CALLER,
    )).rejects.toMatchObject({
      code: 'REMOTE_INVOCATION_PRIVATE_GRAPH_REQUIRED',
      status: 403,
    });
    expect(invokeSkill).not.toHaveBeenCalled();
  });

  it('has the author node independently reject a public-CG inbox request', async () => {
    let inboxHandler: ((request: any, senderPeerId: string) => Promise<any>) | undefined;
    const execute = vi.fn();
    const authorAgent = {
      peerId: 'peer-author',
      ...membership({ isPrivateContextGraph: vi.fn(async () => false) }),
      registerSkill: vi.fn((_skillUri: string, handler: typeof inboxHandler) => {
        inboxHandler = handler;
      }),
      query: vi.fn(async () => programResult()),
      listLocalAgents: () => [{ agentAddress: AUTHOR }],
      getCustodialAgentPrivateKey: () => AUTHOR_KEY,
    } as any;
    registerSemanticRuntimeInboxSkill(authorAgent, {} as any, { enabled: true }, undefined, {
      invoke: execute as any,
    });
    const senderAgent = {
      peerId: 'peer-sender',
      ...membership(),
      query: vi.fn(async () => programResult()),
      listLocalAgents: () => [{ agentAddress: CALLER }],
      resolveLocalAgentAddress: () => CALLER,
      getCustodialAgentPrivateKey: () => CALLER_KEY,
      findAgentPeerIdsByAddress: vi.fn(async () => ['peer-author']),
      invokeSkill: vi.fn(async (_peer: string, skillUri: string, inputData: Uint8Array) =>
        inboxHandler!({ skillUri, inputData }, 'peer-sender')),
    } as any;

    await expect(invokeSemanticProgramOnAuthorNode(
      senderAgent,
      {} as any,
      CONTEXT_GRAPH,
      PROGRAM,
      INVOCATION,
      'vm',
      'vm',
      { enabled: true },
      undefined,
      CALLER,
    )).rejects.toMatchObject({
      code: 'REMOTE_INVOCATION_PRIVATE_GRAPH_REQUIRED',
      status: 403,
    });
    expect(senderAgent.invokeSkill).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an Execution layer change made after the caller wallet signed', async () => {
    let inboxHandler: ((request: any, senderPeerId: string) => Promise<any>) | undefined;
    const authorAgent = {
      peerId: 'peer-author',
      ...membership(),
      registerSkill: vi.fn((_skillUri: string, handler: typeof inboxHandler) => {
        inboxHandler = handler;
      }),
      query: vi.fn(async () => programResult()),
      listLocalAgents: () => [{ agentAddress: AUTHOR }],
      getCustodialAgentPrivateKey: () => AUTHOR_KEY,
    } as any;
    registerSemanticRuntimeInboxSkill(authorAgent, {} as any, { enabled: true }, undefined, {
      invoke: vi.fn() as any,
    });
    const senderAgent = {
      peerId: 'peer-sender',
      ...membership(),
      query: vi.fn(async () => programResult()),
      listLocalAgents: () => [{ agentAddress: CALLER }],
      resolveLocalAgentAddress: () => CALLER,
      getCustodialAgentPrivateKey: () => CALLER_KEY,
      findAgentPeerIdsByAddress: vi.fn(async () => ['peer-author']),
      invokeSkill: vi.fn(async (_peer: string, skillUri: string, inputData: Uint8Array) => {
        const tampered = JSON.parse(new TextDecoder().decode(inputData));
        tampered.executionLayer = 'wm';
        return inboxHandler!({
          skillUri,
          inputData: new TextEncoder().encode(JSON.stringify(tampered)),
        }, 'peer-sender');
      }),
    } as any;

    await expect(invokeSemanticProgramOnAuthorNode(
      senderAgent,
      {} as any,
      CONTEXT_GRAPH,
      PROGRAM,
      INVOCATION,
      'vm',
      'vm',
      { enabled: true },
      undefined,
      CALLER,
    )).rejects.toMatchObject({ code: 'INVOCATION_AUTHORIZATION_INVALID', status: 403 });
  });

  it('has the author node reject a signed request from a wallet outside the Context Graph', async () => {
    let inboxHandler: ((request: any, senderPeerId: string) => Promise<any>) | undefined;
    const execute = vi.fn();
    const authorAgent = {
      peerId: 'peer-author',
      ...membership({
        getContextGraphOwner: vi.fn(async () => `did:dkg:agent:${AUTHOR}`),
      }),
      registerSkill: vi.fn((_skillUri: string, handler: typeof inboxHandler) => {
        inboxHandler = handler;
      }),
      query: vi.fn(async () => programResult()),
      listLocalAgents: () => [{ agentAddress: AUTHOR }],
      getCustodialAgentPrivateKey: () => AUTHOR_KEY,
    } as any;
    registerSemanticRuntimeInboxSkill(authorAgent, {} as any, { enabled: true }, undefined, {
      invoke: execute as any,
    });
    const senderAgent = {
      peerId: 'peer-sender',
      ...membership(),
      query: vi.fn(async () => programResult()),
      listLocalAgents: () => [{ agentAddress: CALLER }],
      resolveLocalAgentAddress: () => CALLER,
      getCustodialAgentPrivateKey: () => CALLER_KEY,
      findAgentPeerIdsByAddress: vi.fn(async () => ['peer-author']),
      invokeSkill: vi.fn(async (_peer: string, skillUri: string, inputData: Uint8Array) =>
        inboxHandler!({ skillUri, inputData }, 'peer-sender')),
    } as any;

    await expect(invokeSemanticProgramOnAuthorNode(
      senderAgent,
      {} as any,
      CONTEXT_GRAPH,
      PROGRAM,
      INVOCATION,
      'vm',
      'vm',
      { enabled: true },
      undefined,
      CALLER,
    )).rejects.toMatchObject({ code: 'PROGRAM_CONTEXT_GRAPH_FORBIDDEN', status: 403 });
    expect(senderAgent.invokeSkill).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
});

import { describe, it, expect } from 'vitest';
import { monotonicTransition, versionedWrite, DKG_STATE_VERSION, DKG_STATE_UPDATED_AT } from '../src/workspace-consistency.js';
import type { DKGAgent } from '../src/dkg-agent.js';

const STAGES = ['recruiting', 'traveling', 'finished'] as const;
const SUBJECT = 'urn:test:swarm:1';
const PREDICATE = 'https://example.org/status';

describe('monotonicTransition', () => {
  it('allows forward transition recruiting → traveling', () => {
    const { condition, quad } = monotonicTransition(STAGES, SUBJECT, PREDICATE, 'recruiting', 'traveling');
    expect(condition.subject).toBe(SUBJECT);
    expect(condition.predicate).toBe(PREDICATE);
    expect(condition.expectedValue).toBe('"recruiting"');
    expect(quad.object).toBe('"traveling"');
  });

  it('allows forward transition traveling → finished', () => {
    const { condition, quad } = monotonicTransition(STAGES, SUBJECT, PREDICATE, 'traveling', 'finished');
    expect(condition.expectedValue).toBe('"traveling"');
    expect(quad.object).toBe('"finished"');
  });

  it('allows skip transition recruiting → finished', () => {
    const { condition, quad } = monotonicTransition(STAGES, SUBJECT, PREDICATE, 'recruiting', 'finished');
    expect(condition.expectedValue).toBe('"recruiting"');
    expect(quad.object).toBe('"finished"');
  });

  it('allows initial creation (null → first stage)', () => {
    const { condition, quad } = monotonicTransition(STAGES, SUBJECT, PREDICATE, null, 'recruiting');
    expect(condition.expectedValue).toBeNull();
    expect(quad.object).toBe('"recruiting"');
  });

  it('rejects backward transition traveling → recruiting', () => {
    expect(() => monotonicTransition(STAGES, SUBJECT, PREDICATE, 'traveling', 'recruiting'))
      .toThrow('Non-monotonic transition');
  });

  it('rejects same-state transition', () => {
    expect(() => monotonicTransition(STAGES, SUBJECT, PREDICATE, 'traveling', 'traveling'))
      .toThrow('Non-monotonic transition');
  });

  it('rejects unknown from stage', () => {
    expect(() => monotonicTransition(STAGES, SUBJECT, PREDICATE, 'unknown', 'finished'))
      .toThrow('not in the stage list');
  });

  it('rejects unknown to stage', () => {
    expect(() => monotonicTransition(STAGES, SUBJECT, PREDICATE, 'recruiting', 'unknown'))
      .toThrow('not in the stage list');
  });

  it('works with 2-element stage list', () => {
    const stages = ['open', 'closed'] as const;
    const { condition, quad } = monotonicTransition(stages, SUBJECT, PREDICATE, 'open', 'closed');
    expect(condition.expectedValue).toBe('"open"');
    expect(quad.object).toBe('"closed"');
  });

  it('escapes quotes and backslashes in stage names', () => {
    const stages = ['status "alpha"', 'status "beta"'] as const;
    const { condition, quad } = monotonicTransition(stages, SUBJECT, PREDICATE, 'status "alpha"', 'status "beta"');
    expect(condition.expectedValue).toBe('"status \\"alpha\\""');
    expect(quad.object).toBe('"status \\"beta\\""');
  });

  it('null → non-first stage is allowed (skip creation)', () => {
    const { condition, quad } = monotonicTransition(STAGES, SUBJECT, PREDICATE, null, 'traveling');
    expect(condition.expectedValue).toBeNull();
    expect(quad.object).toBe('"traveling"');
  });
});

describe('versionedWrite', () => {
  function makeAgent(overrides?: { conditionalShareResult?: any; conditionalShareError?: Error }) {
    const calls: any[][] = [];
    const agent = {
      conditionalShare: async (...args: any[]) => {
        calls.push(args);
        if (overrides?.conditionalShareError) throw overrides.conditionalShareError;
        return overrides?.conditionalShareResult ?? { shareOperationId: 'ws-ver-1' };
      },
    } as unknown as DKGAgent;
    return { agent, calls };
  }

  it('first write (null version) sends absent condition and writes version 1', async () => {
    const { agent, calls } = makeAgent();
    const quads = [{ subject: SUBJECT, predicate: 'http://schema.org/name', object: '"Test"', graph: '' }];

    const result = await versionedWrite(agent, 'test-paranet', SUBJECT, null, quads);

    expect(result.newVersion).toBe(1);
    expect(result.shareOperationId).toBe('ws-ver-1');

    const call = calls[0];
    expect(call[0]).toBe('test-paranet');

    const allQuads = call[1] as Array<{ subject: string; predicate: string; object: string }>;
    const versionQuad = allQuads.find(q => q.predicate === DKG_STATE_VERSION);
    expect(versionQuad).toBeDefined();
    expect(versionQuad!.object).toMatch(/^"1"\^\^<.*integer>$/);

    const timestampQuad = allQuads.find(q => q.predicate === DKG_STATE_UPDATED_AT);
    expect(timestampQuad).toBeDefined();
    expect(timestampQuad!.object).toMatch(/\^\^<.*dateTime>$/);

    const conditions = call[2] as Array<{ subject: string; predicate: string; expectedValue: string | null }>;
    expect(conditions).toHaveLength(1);
    expect(conditions[0].subject).toBe(SUBJECT);
    expect(conditions[0].predicate).toBe(DKG_STATE_VERSION);
    expect(conditions[0].expectedValue).toBeNull();
  });

  it('increments version and sends CAS condition on current version', async () => {
    const { agent, calls } = makeAgent();
    const quads = [{ subject: SUBJECT, predicate: 'http://schema.org/name', object: '"V3"', graph: '' }];

    const result = await versionedWrite(agent, 'test-paranet', SUBJECT, 2, quads);

    expect(result.newVersion).toBe(3);

    const call = calls[0];
    const conditions = call[2] as Array<{ expectedValue: string | null }>;
    expect(conditions[0].expectedValue).toBe('"2"^^<http://www.w3.org/2001/XMLSchema#integer>');

    const allQuads = call[1] as Array<{ predicate: string; object: string }>;
    const versionQuad = allQuads.find(q => q.predicate === DKG_STATE_VERSION);
    expect(versionQuad!.object).toContain('"3"');
  });

  it('includes application quads alongside version quads', async () => {
    const { agent, calls } = makeAgent();
    const appQuads = [
      { subject: SUBJECT, predicate: 'http://schema.org/name', object: '"App Data"', graph: '' },
      { subject: SUBJECT, predicate: 'http://schema.org/desc', object: '"More Data"', graph: '' },
    ];

    await versionedWrite(agent, 'test-paranet', SUBJECT, 0, appQuads);

    const call = calls[0];
    const allQuads = call[1] as Array<{ predicate: string }>;
    expect(allQuads.length).toBe(4); // 2 app + version + timestamp
    expect(allQuads.some(q => q.predicate === 'http://schema.org/name')).toBe(true);
    expect(allQuads.some(q => q.predicate === 'http://schema.org/desc')).toBe(true);
    expect(allQuads.some(q => q.predicate === DKG_STATE_VERSION)).toBe(true);
    expect(allQuads.some(q => q.predicate === DKG_STATE_UPDATED_AT)).toBe(true);
  });

  it('passes localOnly option through to agent', async () => {
    const { agent, calls } = makeAgent();
    await versionedWrite(agent, 'test-paranet', SUBJECT, 0, [], { localOnly: true });

    const call = calls[0];
    expect(call[3]).toEqual({ localOnly: true });
  });

  it('propagates StaleWriteError from agent', async () => {
    const err = new Error('CAS failed');
    err.name = 'StaleWriteError';
    const { agent } = makeAgent({ conditionalShareError: err });

    await expect(versionedWrite(agent, 'test-paranet', SUBJECT, 1, []))
      .rejects.toThrow('CAS failed');
  });
});

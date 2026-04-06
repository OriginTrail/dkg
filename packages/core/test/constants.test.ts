import { describe, it, expect } from 'vitest';
import {
  contextGraphSharedMemoryTopic,
  contextGraphFinalizationTopic,
  contextGraphAppTopic,
  contextGraphDataUri,
  contextGraphSessionsTopic,
  paranetPublishTopic,
  paranetWorkspaceTopic,
} from '../src/constants.js';
import { createOperationContext } from '../src/logger.js';

describe('context graph topic helpers (V10)', () => {
  it('contextGraphFinalizationTopic matches deprecated paranetPublishTopic', () => {
    expect(paranetPublishTopic('testing')).toBe(contextGraphFinalizationTopic('testing'));
    expect(paranetPublishTopic('testing')).toBe('dkg/context-graph/testing/finalization');
  });

  it('contextGraphSharedMemoryTopic matches deprecated paranetWorkspaceTopic', () => {
    expect(paranetWorkspaceTopic('testing')).toBe(contextGraphSharedMemoryTopic('testing'));
    expect(contextGraphSharedMemoryTopic('testing')).toBe('dkg/context-graph/testing/shared-memory');
  });

  it('contextGraphAppTopic returns V10 app topic', () => {
    expect(contextGraphAppTopic('origin-trail-game')).toBe('dkg/context-graph/origin-trail-game/app');
    expect(contextGraphAppTopic('testing')).toBe('dkg/context-graph/testing/app');
  });

  it('contextGraphDataUri returns V10 data URI', () => {
    expect(contextGraphDataUri('agents')).toBe('did:dkg:context-graph:agents');
  });

  it('contextGraphSessionsTopic returns V10 sessions topic', () => {
    expect(contextGraphSessionsTopic('testing')).toBe('dkg/context-graph/testing/sessions');
  });

  it('handles empty string context graph ID (V10 format)', () => {
    expect(contextGraphFinalizationTopic('')).toBe('dkg/context-graph//finalization');
    expect(contextGraphDataUri('')).toBe('did:dkg:context-graph:');
  });

  it('preserves context graph IDs with special characters (V10 format)', () => {
    expect(contextGraphFinalizationTopic('my-context-graph')).toBe(
      'dkg/context-graph/my-context-graph/finalization',
    );
    expect(contextGraphFinalizationTopic('cg_v2')).toBe('dkg/context-graph/cg_v2/finalization');
  });

  it('does not sanitize slashes in context graph IDs (caller responsibility)', () => {
    const result = contextGraphFinalizationTopic('a/b');
    expect(result).toBe('dkg/context-graph/a/b/finalization');
  });
});

describe('createOperationContext', () => {
  it('generates a unique operationId', () => {
    const ctx = createOperationContext('publish');
    expect(ctx.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.operationName).toBe('publish');
    expect(ctx.sourceOperationId).toBeUndefined();
  });

  it('accepts a sourceOperationId for cross-node correlation', () => {
    const sourceId = '550e8400-e29b-41d4-a716-446655440000';
    const ctx = createOperationContext('gossip', sourceId);
    expect(ctx.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.operationId).not.toBe(sourceId);
    expect(ctx.sourceOperationId).toBe(sourceId);
  });
});

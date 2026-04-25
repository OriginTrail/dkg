import { describe, it, expect } from 'vitest';
import {
  contextGraphSharedMemoryTopic,
  contextGraphFinalizationTopic,
  contextGraphAppTopic,
  contextGraphDataUri,
  contextGraphSessionsTopic,
  paranetPublishTopic,
  paranetWorkspaceTopic,
  validateContextGraphId,
  validateSubGraphName,
  validateAssertionName,
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
    expect(contextGraphAppTopic('testing')).toBe('dkg/context-graph/testing/app');
    expect(contextGraphAppTopic('agents')).toBe('dkg/context-graph/agents/app');
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

  it('deprecated paranetPublishTopic delegates to contextGraphFinalizationTopic', () => {
    expect(paranetPublishTopic('my-paranet')).toBe(contextGraphFinalizationTopic('my-paranet'));
    expect(paranetPublishTopic('')).toBe(contextGraphFinalizationTopic(''));
    expect(paranetPublishTopic('a/b')).toBe(contextGraphFinalizationTopic('a/b'));
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

describe('validateContextGraphId', () => {
  it('accepts valid context graph IDs', () => {
    expect(validateContextGraphId('my-context-graph').valid).toBe(true);
    expect(validateContextGraphId('agent-skills').valid).toBe(true);
    expect(validateContextGraphId('cg_v2').valid).toBe(true);
  });

  it('rejects empty IDs', () => {
    expect(validateContextGraphId('').valid).toBe(false);
  });

  it('rejects disallowed characters (whitelist: alphanumeric, _, :, /, ., @, -)', () => {
    expect(validateContextGraphId('foo<bar').valid).toBe(false);
    expect(validateContextGraphId('foo>bar').valid).toBe(false);
    expect(validateContextGraphId('foo bar').valid).toBe(false);
    expect(validateContextGraphId('foo"bar').valid).toBe(false);
    expect(validateContextGraphId('foo{bar').valid).toBe(false);
    expect(validateContextGraphId('foo?bar').valid).toBe(false);
    expect(validateContextGraphId('foo#bar').valid).toBe(false);
  });

  it('accepts URNs, DIDs, and slug-like identifiers', () => {
    expect(validateContextGraphId('did:dkg:test').valid).toBe(true);
    expect(validateContextGraphId('urn:uuid:12345').valid).toBe(true);
    expect(validateContextGraphId('my-graph_v2').valid).toBe(true);
    expect(validateContextGraphId('user@domain').valid).toBe(true);
  });

  it('rejects IDs exceeding 256 chars', () => {
    expect(validateContextGraphId('a'.repeat(257)).valid).toBe(false);
    expect(validateContextGraphId('a'.repeat(256)).valid).toBe(true);
  });

  it('rejects literal traversal path segments', () => {
    expect(validateContextGraphId('../etc/passwd').valid).toBe(false);
    expect(validateContextGraphId('legit-cg/../../other-cg').valid).toBe(false);
  });
});

describe('validateAssertionName', () => {
  it('accepts valid assertion names', () => {
    expect(validateAssertionName('my-assertion').valid).toBe(true);
    expect(validateAssertionName('draft-001').valid).toBe(true);
  });

  it('rejects empty names', () => {
    expect(validateAssertionName('').valid).toBe(false);
  });

  it('rejects names with slashes', () => {
    expect(validateAssertionName('a/b').valid).toBe(false);
  });

  it('rejects IRI-unsafe characters', () => {
    expect(validateAssertionName('a<b').valid).toBe(false);
    expect(validateAssertionName('a b').valid).toBe(false);
  });

  it('rejects names exceeding 256 chars', () => {
    expect(validateAssertionName('a'.repeat(257)).valid).toBe(false);
  });
});

describe('validateSubGraphName', () => {
  it('accepts valid sub-graph names', () => {
    expect(validateSubGraphName('my-sub-graph').valid).toBe(true);
  });

  it('rejects empty names', () => {
    expect(validateSubGraphName('').valid).toBe(false);
  });

  it('rejects underscore-prefixed (reserved)', () => {
    expect(validateSubGraphName('_internal').valid).toBe(false);
  });

  it('rejects slashes', () => {
    expect(validateSubGraphName('a/b').valid).toBe(false);
  });

  it('rejects reserved path segments', () => {
    expect(validateSubGraphName('context').valid).toBe(false);
    expect(validateSubGraphName('assertion').valid).toBe(false);
    expect(validateSubGraphName('draft').valid).toBe(false);
  });

  it('rejects IRI-unsafe characters', () => {
    expect(validateSubGraphName('a<b').valid).toBe(false);
    expect(validateSubGraphName('a b').valid).toBe(false);
  });
});

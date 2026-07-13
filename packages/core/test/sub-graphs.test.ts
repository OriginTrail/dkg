import { describe, it, expect } from 'vitest';
import {
  contextGraphSubGraphUri,
  contextGraphSubGraphMetaUri,
  contextGraphSharedMemoryUri,
  contextGraphSharedMemoryMetaUri,
  contextGraphAssertionUri,
  contextGraphLayerUri,
  parseContextGraphLayerUri,
  validateSubGraphName,
} from '../src/constants.js';
import { MemoryLayer } from '../src/memory-model.js';

describe('sub-graph URI helpers', () => {
  const cgId = 'dkg-v10-dev';

  it('contextGraphSubGraphUri produces correct URI', () => {
    expect(contextGraphSubGraphUri(cgId, 'code')).toBe(
      'did:dkg:context-graph:dkg-v10-dev/code',
    );
  });

  it('contextGraphSubGraphMetaUri produces correct URI', () => {
    expect(contextGraphSubGraphMetaUri(cgId, 'code')).toBe(
      'did:dkg:context-graph:dkg-v10-dev/code/_meta',
    );
  });

  it('different sub-graph names produce different URIs', () => {
    const code = contextGraphSubGraphUri(cgId, 'code');
    const decisions = contextGraphSubGraphUri(cgId, 'decisions');
    expect(code).not.toBe(decisions);
  });

  it('contextGraphSharedMemoryUri with subGraphName produces sub-graph SWM URI', () => {
    expect(contextGraphSharedMemoryUri(cgId, 'code')).toBe(
      'did:dkg:context-graph:dkg-v10-dev/code/_shared_memory',
    );
  });

  it('contextGraphSharedMemoryUri without subGraphName produces root SWM URI', () => {
    expect(contextGraphSharedMemoryUri(cgId)).toBe(
      'did:dkg:context-graph:dkg-v10-dev/_shared_memory',
    );
  });

  it('contextGraphSharedMemoryMetaUri with subGraphName', () => {
    expect(contextGraphSharedMemoryMetaUri(cgId, 'code')).toBe(
      'did:dkg:context-graph:dkg-v10-dev/code/_shared_memory_meta',
    );
  });

  it('contextGraphAssertionUri with subGraphName places sub-graph before assertion', () => {
    expect(contextGraphAssertionUri(cgId, '0xAgent', 'scan', 'code')).toBe(
      'did:dkg:context-graph:dkg-v10-dev/code/assertion/0xAgent/scan',
    );
  });

  it('contextGraphAssertionUri without subGraphName produces flat URI', () => {
    expect(contextGraphAssertionUri(cgId, '0xAgent', 'scan')).toBe(
      'did:dkg:context-graph:dkg-v10-dev/assertion/0xAgent/scan',
    );
  });

  it('parses root per-KA memory layer URIs built by contextGraphLayerUri', () => {
    const uri = contextGraphLayerUri(
      cgId,
      MemoryLayer.SharedWorkingMemory,
      '0x000000000000000000000000000000000000c10A',
      7n,
    );

    expect(parseContextGraphLayerUri(uri)).toEqual({
      contextGraphId: cgId,
      layer: MemoryLayer.SharedWorkingMemory,
      agentAddress: '0x000000000000000000000000000000000000c10a',
      kaNumber: 7n,
    });
  });

  it('parses sub-graph per-KA memory layer URIs built by contextGraphLayerUri', () => {
    const uri = contextGraphLayerUri(
      cgId,
      MemoryLayer.VerifiableMemory,
      '0x000000000000000000000000000000000000c10A',
      '9',
      'code',
    );

    expect(parseContextGraphLayerUri(uri)).toEqual({
      contextGraphId: cgId,
      subGraphName: 'code',
      layer: MemoryLayer.VerifiableMemory,
      agentAddress: '0x000000000000000000000000000000000000c10a',
      kaNumber: 9n,
    });
  });

  it('rejects bucket, staging, and malformed memory graph URIs', () => {
    expect(parseContextGraphLayerUri(contextGraphSharedMemoryUri(cgId))).toBeUndefined();
    expect(parseContextGraphLayerUri(`${contextGraphSharedMemoryUri(cgId)}/staging/tmp`)).toBeUndefined();
    expect(parseContextGraphLayerUri(`${contextGraphSharedMemoryUri(cgId)}/0xabc/7`)).toBeUndefined();
    expect(parseContextGraphLayerUri(`${contextGraphSharedMemoryUri(cgId)}/0x000000000000000000000000000000000000c10A/not-a-number`)).toBeUndefined();
  });

});

describe('validateSubGraphName', () => {
  it('accepts valid names', () => {
    expect(validateSubGraphName('code').valid).toBe(true);
    expect(validateSubGraphName('decisions').valid).toBe(true);
    expect(validateSubGraphName('game-state').valid).toBe(true);
    expect(validateSubGraphName('tasks').valid).toBe(true);
    expect(validateSubGraphName('v2-sessions').valid).toBe(true);
  });

  it('rejects empty name', () => {
    const result = validateSubGraphName('');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('empty');
  });

  it('rejects underscore-prefixed names (reserved for protocol)', () => {
    const result = validateSubGraphName('_meta');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('reserved');

    expect(validateSubGraphName('_shared_memory').valid).toBe(false);
    expect(validateSubGraphName('_private').valid).toBe(false);
  });

  it('rejects names containing slashes', () => {
    const result = validateSubGraphName('code/sub');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('/');
  });

  it('rejects names with IRI-unsafe characters', () => {
    expect(validateSubGraphName('code stuff').valid).toBe(false);
    expect(validateSubGraphName('code<>').valid).toBe(false);
    expect(validateSubGraphName('code"name').valid).toBe(false);
  });

  it('rejects reserved path segments', () => {
    expect(validateSubGraphName('context').valid).toBe(false);
    expect(validateSubGraphName('assertion').valid).toBe(false);
    expect(validateSubGraphName('draft').valid).toBe(false);
  });
});

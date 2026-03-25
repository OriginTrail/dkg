/**
 * Unit tests for code-transformer.ts — entity/import/export quad generation.
 */

import { describe, it, expect } from 'vitest';
import {
  transformCodeEntities, transformRelationships, transformFileTree,
  transformClaim, transformSession, transformDecision, transformAnnotation,
  type ResolvedRelationship, type AgentSessionData, type CodeClaimData, type DecisionData, type AnnotationData,
} from '../src/rdf/code-transformer.js';
import { GH, RDF } from '../src/rdf/uri.js';
import type { Quad } from '../src/rdf/uri.js';
import type { ParseResult } from '../src/code/parser.js';

const GRAPH = 'did:dkg:paranet:test';
const OWNER = 'octocat';
const REPO = 'Hello-World';

function findQuad(quads: Quad[], predicate: string, subject?: string): Quad | undefined {
  return quads.find(q => q.predicate === predicate && (subject === undefined || q.subject === subject));
}

function findQuads(quads: Quad[], predicate: string, subject?: string): Quad[] {
  return quads.filter(q => q.predicate === predicate && (subject === undefined || q.subject === subject));
}

describe('transformCodeEntities', () => {
  it('produces quads for a class entity', () => {
    const result: ParseResult = {
      entities: [{
        kind: 'class',
        name: 'MyClass',
        startLine: 5,
        endLine: 20,
        isExported: true,
        extends: 'BaseClass',
        implements: ['Serializable'],
      }],
      imports: [],
      exports: [],
    };

    const quads = transformCodeEntities(result, 'src/lib.ts', OWNER, REPO, GRAPH);

    const symbolUri = `urn:github:${OWNER}/${REPO}/symbol/${encodeURIComponent('src/lib.ts')}#MyClass`;

    const typeQuad = findQuad(quads, `${RDF}type`, symbolUri);
    expect(typeQuad).toBeDefined();
    expect(typeQuad!.object).toBe(`${GH}Class`);

    const nameQuad = findQuad(quads, `${GH}name`, symbolUri);
    expect(nameQuad).toBeDefined();
    expect(nameQuad!.object).toContain('MyClass');

    const exportedQuad = findQuad(quads, `${GH}exported`, symbolUri);
    expect(exportedQuad).toBeDefined();

    const extendsQuad = findQuad(quads, `${GH}extendsName`, symbolUri);
    expect(extendsQuad).toBeDefined();
    expect(extendsQuad!.object).toContain('BaseClass');

    const implQuad = findQuad(quads, `${GH}implementsName`, symbolUri);
    expect(implQuad).toBeDefined();
    expect(implQuad!.object).toContain('Serializable');
  });

  it('produces quads for a function entity', () => {
    const result: ParseResult = {
      entities: [{
        kind: 'function',
        name: 'processData',
        startLine: 10,
        endLine: 25,
        isAsync: true,
        isExported: true,
        parameters: ['input', 'options'],
        returnType: 'Promise<Result>',
        signature: 'async function processData(input: Data, options: Options): Promise<Result>',
      }],
      imports: [],
      exports: [],
    };

    const quads = transformCodeEntities(result, 'src/utils.ts', OWNER, REPO, GRAPH);

    const symbolUri = `urn:github:${OWNER}/${REPO}/symbol/${encodeURIComponent('src/utils.ts')}#processData`;

    const typeQuad = findQuad(quads, `${RDF}type`, symbolUri);
    expect(typeQuad!.object).toBe(`${GH}Function`);

    const asyncQuad = findQuad(quads, `${GH}async`, symbolUri);
    expect(asyncQuad).toBeDefined();

    const sigQuad = findQuad(quads, `${GH}signature`, symbolUri);
    expect(sigQuad).toBeDefined();
    expect(sigQuad!.object).toContain('processData');

    const paramQuads = findQuads(quads, `${GH}parameter`, symbolUri);
    expect(paramQuads.length).toBe(2);
  });

  it('produces quads for a method with parentClass', () => {
    const result: ParseResult = {
      entities: [{
        kind: 'method',
        name: 'getValue',
        startLine: 15,
        endLine: 18,
        parentClass: 'Store',
        visibility: 'public',
      }],
      imports: [],
      exports: [],
    };

    const quads = transformCodeEntities(result, 'src/store.ts', OWNER, REPO, GRAPH);

    const symbolUri = `urn:github:${OWNER}/${REPO}/symbol/${encodeURIComponent('src/store.ts')}#${encodeURIComponent('Store.getValue')}`;

    const typeQuad = findQuad(quads, `${RDF}type`, symbolUri);
    expect(typeQuad!.object).toBe(`${GH}Method`);

    const parentQuad = findQuad(quads, `${GH}parentClass`, symbolUri);
    expect(parentQuad).toBeDefined();
    expect(parentQuad!.object).toContain('Store');
  });

  it('produces quads for imports', () => {
    const result: ParseResult = {
      entities: [],
      imports: [
        { source: './utils.js', specifiers: ['foo', 'bar'], line: 1 },
        { source: 'react', specifiers: ['useState'], line: 2, isTypeOnly: false },
      ],
      exports: [],
    };

    const quads = transformCodeEntities(result, 'src/app.ts', OWNER, REPO, GRAPH);

    const importQuads = quads.filter(q => q.predicate === `${RDF}type` && q.object === `${GH}Import`);
    expect(importQuads.length).toBe(2);

    const sourceQuads = findQuads(quads, `${GH}importSource`);
    expect(sourceQuads.length).toBe(2);
    expect(sourceQuads.map(q => q.object)).toContain('"./utils.js"');

    const nameQuads = findQuads(quads, `${GH}importedName`);
    expect(nameQuads.length).toBe(3); // foo, bar, useState
  });

  it('produces quads for exports', () => {
    const result: ParseResult = {
      entities: [],
      imports: [],
      exports: [
        { name: 'MyComponent', kind: 'class', line: 1 },
        { name: 'default', kind: 'default', line: 50, isDefault: true },
      ],
    };

    const quads = transformCodeEntities(result, 'src/component.ts', OWNER, REPO, GRAPH);

    const exportQuads = quads.filter(q => q.predicate === `${RDF}type` && q.object === `${GH}Export`);
    expect(exportQuads.length).toBe(2);

    const defaultQuad = findQuad(quads, `${GH}defaultExport`);
    expect(defaultQuad).toBeDefined();
  });
});

describe('transformRelationships', () => {
  it('produces import relationship quads', () => {
    const rels: ResolvedRelationship[] = [
      {
        kind: 'imports',
        sourceUri: 'urn:github:octocat/Hello-World/file/src%2Fapp.ts',
        targetUri: 'urn:github:octocat/Hello-World/file/src%2Futils.ts',
      },
    ];

    const quads = transformRelationships(rels, GRAPH);
    expect(quads.length).toBe(1);
    expect(quads[0].predicate).toBe(`${GH}imports`);
  });

  it('produces inherits relationship quads', () => {
    const rels: ResolvedRelationship[] = [
      {
        kind: 'inherits',
        sourceUri: 'urn:github:o/r/symbol/src%2Fdog.ts#Dog',
        targetUri: 'urn:github:o/r/symbol/src%2Fanimal.ts#Animal',
      },
    ];

    const quads = transformRelationships(rels, GRAPH);
    expect(quads.length).toBe(1);
    expect(quads[0].predicate).toBe(`${GH}inherits`);
  });

  it('produces implements relationship quads', () => {
    const rels: ResolvedRelationship[] = [
      {
        kind: 'implements',
        sourceUri: 'urn:github:o/r/symbol/src%2Fservice.ts#Service',
        targetUri: 'urn:github:o/r/symbol/src%2Finterfaces.ts#IService',
      },
    ];

    const quads = transformRelationships(rels, GRAPH);
    expect(quads.length).toBe(1);
    expect(quads[0].predicate).toBe(`${GH}implements`);
  });
});

describe('transformFileTree', () => {
  it('produces File and Directory quads', () => {
    const entries = [
      { path: 'src', mode: '040000', type: 'tree' as const, sha: 'abc', size: undefined },
      { path: 'src/index.ts', mode: '100644', type: 'blob' as const, sha: 'def', size: 1024 },
    ];

    const quads = transformFileTree(entries, OWNER, REPO, GRAPH);

    const dirQuad = quads.find(q => q.predicate === `${RDF}type` && q.object === `${GH}Directory`);
    expect(dirQuad).toBeDefined();

    const fileQuad = quads.find(q => q.predicate === `${RDF}type` && q.object === `${GH}File`);
    expect(fileQuad).toBeDefined();

    const sizeQuad = findQuad(quads, `${GH}fileSize`);
    expect(sizeQuad).toBeDefined();

    const langQuad = findQuad(quads, `${GH}language`);
    expect(langQuad).toBeDefined();
    expect(langQuad!.object).toContain('TypeScript');
  });
});

describe('transformClaim', () => {
  it('produces ClaimedRegion type (not CodeClaim)', () => {
    const claim: CodeClaimData = {
      claimId: 'clm-1',
      filePath: 'src/auth.ts',
      peerId: 'peer-abc',
      agentName: 'claude-1',
      sessionId: 'sess-1',
      claimedAt: 1711234567000,
    };

    const quads = transformClaim(claim, OWNER, REPO, GRAPH);

    const typeQuad = quads.find(q => q.predicate === `${RDF}type`);
    expect(typeQuad).toBeDefined();
    expect(typeQuad!.object).toBe(`${GH}ClaimedRegion`);
    // Must NOT be CodeClaim
    expect(typeQuad!.object).not.toContain('CodeClaim');
  });

  it('includes peerId quad', () => {
    const claim: CodeClaimData = {
      claimId: 'clm-2',
      filePath: 'src/db.ts',
      peerId: 'peer-xyz',
      agentName: 'agent-2',
      sessionId: 'sess-2',
      claimedAt: 1711234567000,
    };

    const quads = transformClaim(claim, OWNER, REPO, GRAPH);

    const peerQuad = findQuad(quads, `${GH}peerId`);
    expect(peerQuad).toBeDefined();
    expect(peerQuad!.object).toContain('peer-xyz');
  });
});

describe('transformDecision', () => {
  it('includes peerId quad', () => {
    const decision: DecisionData = {
      decisionId: 'dec-1',
      summary: 'Use Redis for caching',
      rationale: 'Lower latency than Postgres',
      peerId: 'peer-dec',
      agentName: 'claude-1',
      affectedFiles: ['src/cache.ts'],
      createdAt: 1711234567000,
    };

    const quads = transformDecision(decision, OWNER, REPO, GRAPH);

    const peerQuad = findQuad(quads, `${GH}peerId`);
    expect(peerQuad).toBeDefined();
    expect(peerQuad!.object).toContain('peer-dec');
  });
});

describe('transformAnnotation', () => {
  it('includes peerId quad', () => {
    const annotation: AnnotationData = {
      annotationId: 'ann-1',
      targetUri: 'urn:github:octocat/Hello-World/file/src%2Fauth.ts',
      kind: 'warning',
      content: 'Missing rate limiting',
      peerId: 'peer-ann',
      agentName: 'claude-1',
      createdAt: 1711234567000,
    };

    const quads = transformAnnotation(annotation, OWNER, REPO, GRAPH);

    const peerQuad = findQuad(quads, `${GH}peerId`);
    expect(peerQuad).toBeDefined();
    expect(peerQuad!.object).toContain('peer-ann');
  });
});

describe('transformSession', () => {
  it('includes lastHeartbeat when present', () => {
    const session: AgentSessionData = {
      sessionId: 'sess-hb',
      agentName: 'claude-1',
      peerId: 'peer-hb',
      startedAt: 1711234567000,
      lastHeartbeat: 1711234600000,
      status: 'active',
      modifiedFiles: [],
    };

    const quads = transformSession(session, OWNER, REPO, GRAPH);

    const hbQuad = findQuad(quads, `${GH}lastHeartbeat`);
    expect(hbQuad).toBeDefined();
    expect(hbQuad!.object).toContain('2024-03-');
  });

  it('omits lastHeartbeat when absent', () => {
    const session: AgentSessionData = {
      sessionId: 'sess-nohb',
      agentName: 'claude-1',
      peerId: 'peer-nohb',
      startedAt: 1711234567000,
      status: 'active',
      modifiedFiles: [],
    };

    const quads = transformSession(session, OWNER, REPO, GRAPH);

    const hbQuad = findQuad(quads, `${GH}lastHeartbeat`);
    expect(hbQuad).toBeUndefined();
  });

  it('includes peerId quad', () => {
    const session: AgentSessionData = {
      sessionId: 'sess-pid',
      agentName: 'agent-x',
      peerId: 'peer-session-123',
      startedAt: 1711234567000,
      status: 'active',
      modifiedFiles: [],
    };

    const quads = transformSession(session, OWNER, REPO, GRAPH);

    const peerQuad = findQuad(quads, `${GH}peerId`);
    expect(peerQuad).toBeDefined();
    expect(peerQuad!.object).toContain('peer-session-123');
  });
});

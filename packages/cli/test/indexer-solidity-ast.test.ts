import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { indexSolidityBuildInfo } from '../src/indexer-solidity-ast.js';
import { indexRepository } from '../src/indexer.js';

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

const DEVGRAPH = 'https://ontology.dkg.io/devgraph#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function typeOf(cls: string): string { return `${DEVGRAPH}${cls}`; }
function pred(p: string): string { return `${DEVGRAPH}${p}`; }

// A minimal hand-authored Hardhat build-info fixture. Keeps the test
// fully self-contained and deterministic — no dependency on a real solc
// run in the sandbox.
function buildInfoFixture() {
  return {
    id: 'fixture',
    _format: 'hh-sol-build-info-1',
    solcVersion: '0.8.20',
    solcLongVersion: '0.8.20+commit.a1b79de6',
    input: { language: 'Solidity', sources: {}, settings: {} },
    output: {
      contracts: {},
      sources: {
        'contracts/Token.sol': {
          id: 0,
          ast: {
            id: 1, nodeType: 'SourceUnit', absolutePath: 'contracts/Token.sol',
            license: 'MIT',
            nodes: [
              { id: 2, nodeType: 'PragmaDirective', literals: ['solidity', '^', '0.8', '.20'] },
              {
                id: 10, nodeType: 'ContractDefinition', name: 'Token',
                abstract: false, contractKind: 'contract',
                baseContracts: [],
                documentation: { id: 11, nodeType: 'StructuredDocumentation', text: '@title Token' },
                nodes: [
                  {
                    id: 20, nodeType: 'VariableDeclaration', name: 'totalSupply',
                    visibility: 'public', constant: false, mutability: 'mutable',
                    typeDescriptions: { typeString: 'uint256' },
                  },
                  {
                    id: 21, nodeType: 'VariableDeclaration', name: 'CAP',
                    visibility: 'public', constant: true, mutability: 'constant',
                    typeDescriptions: { typeString: 'uint256' },
                  },
                  {
                    id: 30, nodeType: 'EventDefinition', name: 'Transfer',
                    parameters: { parameters: [
                      { name: 'from', typeDescriptions: { typeString: 'address' } },
                      { name: 'to',   typeDescriptions: { typeString: 'address' } },
                      { name: 'val',  typeDescriptions: { typeString: 'uint256' } },
                    ]},
                  },
                  {
                    id: 31, nodeType: 'ErrorDefinition', name: 'NotOwner',
                    parameters: { parameters: [] },
                  },
                  {
                    id: 40, nodeType: 'ModifierDefinition', name: 'onlyOwner',
                    virtual: false,
                    parameters: { parameters: [] },
                  },
                  {
                    id: 50, nodeType: 'FunctionDefinition', name: 'transfer',
                    kind: 'function', visibility: 'public', stateMutability: 'nonpayable',
                    virtual: false,
                    parameters: { parameters: [
                      { name: 'to', typeDescriptions: { typeString: 'address' } },
                      { name: 'amount', typeDescriptions: { typeString: 'uint256' } },
                    ]},
                    returnParameters: { parameters: [
                      { name: '', typeDescriptions: { typeString: 'bool' } },
                    ]},
                    modifiers: [
                      { modifierName: { name: 'onlyOwner', referencedDeclaration: 40 } },
                    ],
                    body: {
                      id: 51, nodeType: 'Block',
                      statements: [
                        {
                          id: 52, nodeType: 'ExpressionStatement',
                          expression: {
                            nodeType: 'FunctionCall',
                            expression: { nodeType: 'Identifier', referencedDeclaration: 60 },
                          },
                        },
                        {
                          id: 53, nodeType: 'EmitStatement',
                          eventCall: { expression: { nodeType: 'Identifier', referencedDeclaration: 30 } },
                        },
                      ],
                    },
                    documentation: { text: '@notice Transfer tokens to `to`.' },
                  },
                  {
                    id: 60, nodeType: 'FunctionDefinition', name: '_debit',
                    kind: 'function', visibility: 'internal', stateMutability: 'nonpayable',
                    parameters: { parameters: [] },
                    returnParameters: { parameters: [] },
                    modifiers: [],
                    body: { id: 61, nodeType: 'Block', statements: [] },
                  },
                ],
              },
            ],
          },
        },
        // Dependency — should be skipped (not under `contracts/`).
        '@openzeppelin/contracts/Foo.sol': {
          id: 1,
          ast: {
            id: 100, nodeType: 'SourceUnit', absolutePath: '@openzeppelin/contracts/Foo.sol',
            nodes: [],
          },
        },
      },
    },
  };
}

describe('indexSolidityBuildInfo', () => {
  let repoRoot = '';
  let pkgDir = '';

  beforeAll(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'dkg-sol-ast-test-'));
    pkgDir = join(repoRoot, 'packages/contracts-pkg');
    await write(
      join(pkgDir, 'artifacts/build-info/fixture.json'),
      JSON.stringify(buildInfoFixture()),
    );
  });

  afterAll(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  });

  it('emits Contract / Function / Event / Error / Modifier / StateVariable nodes', async () => {
    const result = await indexSolidityBuildInfo(repoRoot, pkgDir, '@acme/contracts');

    expect(result.sourceCount).toBe(1);                // only contracts/Token.sol
    expect(result.skippedDependencyCount).toBe(1);     // @openzeppelin/… skipped
    expect(result.contractCount).toBe(1);
    expect(result.functionCount).toBe(2);              // transfer + _debit
    expect(result.eventCount).toBe(1);                 // Transfer
    expect(result.errorCount).toBe(1);                 // NotOwner
    expect(result.modifierCount).toBe(1);              // onlyOwner
    expect(result.stateVariableCount).toBe(2);         // totalSupply + CAP
  });

  it('attaches visibility, stateMutability, docstring, constant flag', async () => {
    const { quads } = await indexSolidityBuildInfo(repoRoot, pkgDir, '@acme/contracts');

    const hasQuad = (p: string, expectedSubstring: string): boolean =>
      quads.some(q => q.predicate === p && q.object.includes(expectedSubstring));

    expect(hasQuad(pred('visibility'), '"public"')).toBe(true);
    expect(hasQuad(pred('stateMutability'), '"nonpayable"')).toBe(true);
    expect(hasQuad(pred('functionKind'), '"function"')).toBe(true);
    expect(hasQuad(pred('docstring'), 'Transfer tokens to')).toBe(true);
    expect(hasQuad(pred('isConstant'), '"true"')).toBe(true);   // CAP
    expect(hasQuad(pred('contractKind'), '"contract"')).toBe(true);
    expect(hasQuad(pred('license'), '"MIT"')).toBe(true);
  });

  it('resolves usesModifier, calls, and emits as cross-URI references', async () => {
    const { quads } = await indexSolidityBuildInfo(repoRoot, pkgDir, '@acme/contracts');

    const modifierQuads  = quads.filter(q => q.predicate === pred('usesModifier'));
    const callQuads      = quads.filter(q => q.predicate === pred('calls'));
    const emitsQuads     = quads.filter(q => q.predicate === pred('emits'));

    // usesModifier should resolve to the Modifier's full URI, not a string literal.
    expect(modifierQuads.some(q => q.object.includes('/modifier/onlyOwner#40'))).toBe(true);
    // calls should resolve transfer → _debit.
    expect(callQuads.some(q => q.object.includes('/fn/_debit#60'))).toBe(true);
    // emits should resolve to the Transfer event URI.
    expect(emitsQuads.some(q => q.object.includes('/event/Transfer#30'))).toBe(true);
  });

  it('keeps the legacy emitsEvent string on the Contract for back-compat', async () => {
    const { quads } = await indexSolidityBuildInfo(repoRoot, pkgDir, '@acme/contracts');
    const legacyEmit = quads.find(
      q => q.predicate === pred('emitsEvent') && q.object === '"Transfer"',
    );
    expect(legacyEmit).toBeDefined();
  });

  it('skips the regex Solidity pass when --solidityAst is set on indexRepository', async () => {
    // Full `indexRepository` with a pnpm workspace and a matching package so
    // that both passes would normally consider the same .sol file.
    const fullRoot = await mkdtemp(join(tmpdir(), 'dkg-sol-ast-repo-'));
    try {
      await write(join(fullRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
      await write(
        join(fullRoot, 'packages/contracts-pkg/package.json'),
        JSON.stringify({ name: '@acme/contracts', version: '0.0.0' }),
      );
      await write(
        join(fullRoot, 'packages/contracts-pkg/contracts/Token.sol'),
        '// SPDX-License-Identifier: MIT\npragma solidity 0.8.20;\ncontract Token { event Transfer(); }\n',
      );
      await write(
        join(fullRoot, 'packages/contracts-pkg/artifacts/build-info/fixture.json'),
        JSON.stringify(buildInfoFixture()),
      );

      const result = await indexRepository(fullRoot, { solidityAst: true });

      // The Contract URI comes from the AST pass (stable scheme), not the regex pass.
      const contractQuads = result.quads.filter(q => q.object === typeOf('Contract'));
      expect(contractQuads.length).toBe(1);
      // Regex pass would have emitted a `signature` quad for the Function — AST pass does not.
      // That's enough to assert the AST pass won and the regex pass was suppressed for this file.
      const astFunctions = result.quads.filter(q => q.object === typeOf('Function'));
      expect(astFunctions.length).toBeGreaterThan(0);
      expect(astFunctions.every(q => !q.subject.includes('/fn/') || q.subject.includes('#'))).toBe(true);
    } finally {
      await rm(fullRoot, { recursive: true, force: true });
    }
  });
});

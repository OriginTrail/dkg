// Cross-cutting verification suite for the agent-provenance work.
//
// Mirrors the nine static-checkable invariants from the
// "cross-cutting verification" list in the agent-provenance plan
// (RFC §9.7). The dynamic invariants (replay protection, four
// publisher-side branches, EIP-712 attestation gate, EIP-1271
// dispatch) are covered by the on-chain test suites in
// `packages/evm-module/test/unit/KnowledgeAssetsV10.test.ts`
// and the e2e conviction tests; this file pins the
// fast / static / ABI-shape ones so a CI run flags regressions
// without needing to spin up Hardhat.
//
// Maps to the RFC §9.7 list:
//
//  1. five-role separation round-trip                — covered by KAv10 e2e
//  2. strict-break ABI check                          — covered HERE (static ABI)
//  3. gateway-as-publisher path absent                — covered HERE (static grep)
//  4. paymaster fully removed from active flows      — covered HERE (static grep)
//  5. replay protection negative cases revert         — covered by KAv10 unit tests
//  6. publisher-service flow with zero-ETH zero-TRAC  — covered by v10-e2e-conviction
//  7. direct-spend with self-claimed attribution     — covered by KAv10 unit tests
//  8. direct-spend without attribution               — covered by KAv10 unit tests
//  9. unauthorized-PCA fall-through                  — covered by KAv10 unit tests

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

interface AbiItem {
  type: string;
  name?: string;
  inputs?: Array<{
    name?: string;
    type?: string;
    components?: AbiItem['inputs'];
  }>;
}

function loadAbi(rel: string): AbiItem[] {
  const path = join(REPO_ROOT, rel);
  return JSON.parse(readFileSync(path, 'utf8')) as AbiItem[];
}

function flattenInputNames(items?: AbiItem['inputs']): string[] {
  if (!items) return [];
  const out: string[] = [];
  for (const item of items) {
    if (item.name) out.push(item.name);
    if (item.components) out.push(...flattenInputNames(item.components));
  }
  return out;
}

interface SourceWalkOpts {
  /** Workspace-relative directory roots to walk. */
  roots: string[];
  /** Regex; matches collected as findings. */
  pattern: RegExp;
  /** File extensions to search. */
  exts: string[];
  /** Path substrings to skip (e.g. legacy nested workspaces). */
  excludePathSubstrings?: string[];
}

interface SourceFinding {
  file: string;
  line: number;
  text: string;
}

function findInSources(opts: SourceWalkOpts): SourceFinding[] {
  const findings: SourceFinding[] = [];
  for (const root of opts.roots) {
    const abs = join(REPO_ROOT, root);
    walk(abs, (path) => {
      if (!opts.exts.some((ext) => path.endsWith(ext))) return;
      if (
        opts.excludePathSubstrings?.some((sub) => path.includes(sub))
      ) {
        return;
      }
      const text = readFileSync(path, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        if (opts.pattern.test(line)) {
          findings.push({
            file: path.slice(REPO_ROOT.length + 1),
            line: idx + 1,
            text: line.trim(),
          });
        }
      });
    });
  }
  return findings;
}

function walk(dir: string, visit: (path: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.'))
      continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, visit);
    } else if (st.isFile()) {
      visit(full);
    }
  }
}

describe('Cross-cutting verification — agent-provenance via on-chain author attestation', () => {
  describe('§9.7 #2 — strict-break ABI surface (KnowledgeAssetsV10)', () => {
    const abi = loadAbi('packages/chain/abi/KnowledgeAssetsV10.json');
    const fns = abi.filter((x) => x.type === 'function');
    const fnNames = fns.map((f) => f.name);

    it('exposes a unified `publish(PublishParams)` entrypoint', () => {
      expect(fnNames).toContain('publish');
    });

    it('exposes a unified `update(UpdateParams)` entrypoint', () => {
      expect(fnNames).toContain('update');
    });

    it('does NOT expose the deprecated `publishDirect` selector', () => {
      expect(fnNames).not.toContain('publishDirect');
    });

    it('does NOT expose the deprecated `updateDirect` selector', () => {
      expect(fnNames).not.toContain('updateDirect');
    });

    it('PublishParams carries the four required author fields', () => {
      const publish = fns.find((f) => f.name === 'publish');
      expect(publish).toBeDefined();
      const argNames = flattenInputNames(publish!.inputs);
      expect(argNames).toContain('authorAddress');
      expect(argNames).toContain('authorR');
      expect(argNames).toContain('authorVS');
      expect(argNames).toContain('authorSchemeVersion');
    });

    it('PublishParams does NOT carry the removed publisherNodeR/VS fields', () => {
      const publish = fns.find((f) => f.name === 'publish');
      const argNames = flattenInputNames(publish!.inputs);
      expect(argNames).not.toContain('publisherNodeR');
      expect(argNames).not.toContain('publisherNodeVS');
    });

    it('UpdateParams does NOT carry the removed publisherNodeR/VS fields', () => {
      const update = fns.find((f) => f.name === 'update');
      const argNames = flattenInputNames(update!.inputs);
      expect(argNames).not.toContain('publisherNodeR');
      expect(argNames).not.toContain('publisherNodeVS');
    });
  });

  describe('§9.7 #2 — KnowledgeCollectionStorage event ABI carries indexed author', () => {
    const abi = loadAbi('packages/chain/abi/KnowledgeCollectionStorage.json');
    const events = abi.filter((x) => x.type === 'event');

    it('KnowledgeCollectionCreated emits indexed `author`', () => {
      const evt = events.find((e) => e.name === 'KnowledgeCollectionCreated');
      expect(evt).toBeDefined();
      const argNames = flattenInputNames(evt!.inputs);
      expect(argNames).toContain('author');
    });

    it('KnowledgeCollectionUpdated emits indexed `author`', () => {
      const evt = events.find((e) => e.name === 'KnowledgeCollectionUpdated');
      expect(evt).toBeDefined();
      const argNames = flattenInputNames(evt!.inputs);
      expect(argNames).toContain('author');
    });
  });

  describe('§9.7 #3 — gateway-as-publisher pattern fully removed', () => {
    it('no remaining gateway-as-publisher symbols in any package src/', () => {
      const findings = findInSources({
        roots: [
          'packages/agent/src',
          'packages/publisher/src',
          'packages/cli/src',
          'packages/chain/src',
          'packages/adapter-openclaw/src',
          'packages/adapter-hermes/src',
        ],
        pattern: /\b(gatewayAsPublisher|gateway_as_publisher|gateway-publisher)\b/,
        exts: ['.ts', '.js'],
        excludePathSubstrings: ['origin-trail-game/.test-nodes/'],
      });
      expect(findings).toEqual([]);
    });
  });

  describe('§9.7 #4 — Paymaster fully removed from active publish/agent flows', () => {
    it('no Paymaster references in publisher/cli/agent src/', () => {
      const findings = findInSources({
        roots: [
          'packages/publisher/src',
          'packages/cli/src',
          'packages/agent/src',
        ],
        pattern: /\b(Paymaster|PaymasterManager|paymaster)\b/,
        exts: ['.ts', '.js'],
        excludePathSubstrings: ['origin-trail-game/.test-nodes/'],
      });
      if (findings.length > 0) {
        const summary = findings
          .slice(0, 5)
          .map((f) => `${f.file}:${f.line}: ${f.text}`)
          .join('\n');
        throw new Error(
          `Paymaster references detected in active source:\n${summary}` +
            (findings.length > 5
              ? `\n... and ${findings.length - 5} more`
              : ''),
        );
      }
      expect(findings).toEqual([]);
    });
  });

  describe('§5.2 — DKG ontology constants for off-chain provenance', () => {
    it('dkg-core exports the three publication-provenance predicates', async () => {
      const core = await import('@origintrail-official/dkg-core');
      const ontology = (core as any).DKG_ONTOLOGY ?? core;
      const required = [
        'https://dkg.network/ontology#Publication',
        'https://dkg.network/ontology#publishOperationId',
        'https://dkg.network/ontology#authoredBy',
      ];
      const exported: string[] = [];
      const seen = new Set<unknown>();
      const walkExports = (obj: unknown) => {
        if (typeof obj !== 'object' || obj === null) return;
        if (seen.has(obj)) return;
        seen.add(obj);
        for (const v of Object.values(obj as Record<string, unknown>)) {
          if (typeof v === 'string') exported.push(v);
          else if (typeof v === 'object') walkExports(v);
        }
      };
      walkExports(ontology);
      for (const uri of required) {
        expect(exported).toContain(uri);
      }
    });
  });

  describe('§9.7 #1 — chain adapter exposes verified-author surface', () => {
    it('OnChainPublishResult.authorAddress is part of the published interface', async () => {
      const src = readFileSync(
        join(PKG_ROOT, 'src/chain-adapter.ts'),
        'utf8',
      );
      expect(src).toMatch(/authorAddress\?:\s*string/);
      expect(src).toMatch(/getLatestMerkleRootAuthor\?\(/);
    });
  });
});

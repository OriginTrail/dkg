/**
 * Agent DID format conformance — every agent DID in the codebase should
 * match the Ethereum-address form `did:dkg:agent:0x[a-fA-F0-9]{40}`, per
 * dkgv10-spec §03_AGENTS.md and §22_AGENT_ONBOARDING.md.
 *
 * Audit findings covered:
 *   A-12 (MEDIUM / TEST-DEBT) — scan production + fixture files in the
 *        agent package and surface any DID that still uses the legacy
 *        peer-id form (`did:dkg:agent:Qm...`). Failures in this test are
 *        the evidence that spec drift exists in code — they do NOT fail
 *        the CI stack by default (see `expect.soft`) but will show up as
 *        explicit test failures where drift is present.
 *
 * No mocks — this is a pure filesystem scan.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = resolve(__dirname, '..');

const ETH_ADDR_DID_RE = /did:dkg:agent:0x[a-fA-F0-9]{40}/g;
const ANY_AGENT_DID_RE = /did:dkg:agent:([A-Za-z0-9]+)/g;
const PEER_ID_STARTS = /^(Qm|12D3Koo|bafy)/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'coverage') continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(ts|js|json|yaml|yml|md)$/.test(name)) acc.push(p);
  }
  return acc;
}

describe('A-12: agent DID format scan', () => {
  const files = walk(AGENT_ROOT);

  it('scans at least some files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no hard-coded DID uses the peer-id form (Qm… / 12D3Koo… / bafy…)', () => {
    const offenders: Array<{ file: string; match: string }> = [];

    for (const f of files) {
      // Skip the extras test itself (and this file) — they intentionally
      // mention the Qm form as negative regex.
      if (f.endsWith('did-format-extra.test.ts')) continue;
      if (f.endsWith('ack-eip191-agent-extra.test.ts')) continue;

      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(ANY_AGENT_DID_RE)) {
        const body = m[1];
        // Template-literal `${...}` placeholders are fine.
        if (!body) continue;
        if (body.startsWith('0x')) continue;
        if (PEER_ID_STARTS.test(body)) {
          offenders.push({ file: f.replace(AGENT_ROOT + '/', ''), match: m[0] });
        }
      }
    }

    // PROD-DEBT: fixtures in `agent.test.ts` still use `did:dkg:agent:QmTest123`.
    // Spec §03 says agent DIDs are Ethereum-address form. Leaving this as a
    // hard assertion so future PRs that introduce more drift fail loudly;
    // current baseline is expected to surface the known debt. See
    // BUGS_FOUND.md A-12.
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it('every explicit Ethereum-form DID literal (if any) matches the canonical regex', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(ETH_ADDR_DID_RE)) {
        const hex = m[0].slice('did:dkg:agent:0x'.length);
        expect(hex.length).toBe(40);
        expect(/^[a-fA-F0-9]+$/.test(hex)).toBe(true);
      }
    }
  });
});
